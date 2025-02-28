import type { NodePath, Scope, Visitor } from "@babel/traverse";
import { types as t, template } from "@babel/core";
import ReplaceSupers from "@babel/helper-replace-supers";
import splitExportDeclaration from "@babel/helper-split-export-declaration";
import * as charCodes from "charcodes";
import type { PluginAPI, PluginObject, PluginPass } from "@babel/core";
import { skipTransparentExprWrappers } from "@babel/helper-skip-transparent-expression-wrappers";
import {
  privateNameVisitorFactory,
  type PrivateNameVisitorState,
} from "./fields.ts";
import { memoiseComputedKey } from "./misc.ts";

interface Options {
  /** @deprecated use `constantSuper` assumption instead. Only supported in 2021-12 version. */
  loose?: boolean;
}

type ClassDecoratableElement =
  | t.ClassMethod
  | t.ClassPrivateMethod
  | t.ClassProperty
  | t.ClassPrivateProperty
  | t.ClassAccessorProperty;

type ClassElement =
  | ClassDecoratableElement
  | t.TSDeclareMethod
  | t.TSIndexSignature
  | t.StaticBlock;

type ClassElementCanHaveComputedKeys =
  | t.ClassMethod
  | t.ClassProperty
  | t.ClassAccessorProperty;

// TODO(Babel 8): Only keep 2023-11
export type DecoratorVersionKind =
  | "2023-11"
  | "2023-05"
  | "2023-01"
  | "2022-03"
  | "2021-12";

function incrementId(id: number[], idx = id.length - 1): void {
  // If index is -1, id needs an additional character, unshift A
  if (idx === -1) {
    id.unshift(charCodes.uppercaseA);
    return;
  }

  const current = id[idx];

  if (current === charCodes.uppercaseZ) {
    // if current is Z, skip to a
    id[idx] = charCodes.lowercaseA;
  } else if (current === charCodes.lowercaseZ) {
    // if current is z, reset to A and carry the 1
    id[idx] = charCodes.uppercaseA;
    incrementId(id, idx - 1);
  } else {
    // else, increment by one
    id[idx] = current + 1;
  }
}

/**
 * Generates a new private name that is unique to the given class. This can be
 * used to create extra class fields and methods for the implementation, while
 * keeping the length of those names as small as possible. This is important for
 * minification purposes (though private names can generally be minified,
 * transpilations and polyfills cannot yet).
 */
function createPrivateUidGeneratorForClass(
  classPath: NodePath<t.ClassDeclaration | t.ClassExpression>,
): () => t.PrivateName {
  const currentPrivateId: number[] = [];
  const privateNames = new Set<string>();

  classPath.traverse({
    PrivateName(path) {
      privateNames.add(path.node.id.name);
    },
  });

  return (): t.PrivateName => {
    let reifiedId;
    do {
      incrementId(currentPrivateId);
      reifiedId = String.fromCharCode(...currentPrivateId);
    } while (privateNames.has(reifiedId));

    return t.privateName(t.identifier(reifiedId));
  };
}

/**
 * Wraps the above generator function so that it's run lazily the first time
 * it's actually required. Several types of decoration do not require this, so it
 * saves iterating the class elements an additional time and allocating the space
 * for the Sets of element names.
 */
function createLazyPrivateUidGeneratorForClass(
  classPath: NodePath<t.ClassDeclaration | t.ClassExpression>,
): () => t.PrivateName {
  let generator: () => t.PrivateName;

  return (): t.PrivateName => {
    if (!generator) {
      generator = createPrivateUidGeneratorForClass(classPath);
    }

    return generator();
  };
}

/**
 * Takes a class definition and the desired class name if anonymous and
 * replaces it with an equivalent class declaration (path) which is then
 * assigned to a local variable (id). This allows us to reassign the local variable with the
 * decorated version of the class. The class definition retains its original
 * name so that `toString` is not affected, other references to the class
 * are renamed instead.
 */
function replaceClassWithVar(
  path: NodePath<t.ClassDeclaration | t.ClassExpression>,
  className: string | t.Identifier | t.StringLiteral | undefined,
): {
  id: t.Identifier;
  path: NodePath<t.ClassDeclaration | t.ClassExpression>;
} {
  const id = path.node.id;
  const scope = path.scope;
  if (path.type === "ClassDeclaration") {
    const className = id.name;
    const varId = scope.generateUidIdentifierBasedOnNode(id);
    const classId = t.identifier(className);

    scope.rename(className, varId.name);

    path.get("id").replaceWith(classId);

    return { id: t.cloneNode(varId), path };
  } else {
    let varId: t.Identifier;

    if (id) {
      className = id.name;
      varId = generateLetUidIdentifier(scope.parent, className);
      scope.rename(className, varId.name);
    } else {
      varId = generateLetUidIdentifier(
        scope.parent,
        typeof className === "string" ? className : "decorated_class",
      );
    }

    const newClassExpr = t.classExpression(
      typeof className === "string" ? t.identifier(className) : null,
      path.node.superClass,
      path.node.body,
    );

    const [newPath] = path.replaceWith(
      t.sequenceExpression([newClassExpr, varId]),
    );

    return {
      id: t.cloneNode(varId),
      path: newPath.get("expressions.0") as NodePath<t.ClassExpression>,
    };
  }
}

function generateClassProperty(
  key: t.PrivateName | t.Identifier,
  value: t.Expression | undefined,
  isStatic: boolean,
): t.ClassPrivateProperty | t.ClassProperty {
  if (key.type === "PrivateName") {
    return t.classPrivateProperty(key, value, undefined, isStatic);
  } else {
    return t.classProperty(key, value, undefined, undefined, isStatic);
  }
}

function addProxyAccessorsFor(
  className: t.Identifier,
  element: NodePath<ClassDecoratableElement>,
  getterKey: t.PrivateName | t.Expression,
  setterKey: t.PrivateName | t.Expression,
  targetKey: t.PrivateName,
  isComputed: boolean,
  isStatic: boolean,
  version: DecoratorVersionKind,
): void {
  const thisArg =
    (version === "2023-11" ||
      (!process.env.BABEL_8_BREAKING && version === "2023-05")) &&
    isStatic
      ? className
      : t.thisExpression();

  const getterBody = t.blockStatement([
    t.returnStatement(
      t.memberExpression(t.cloneNode(thisArg), t.cloneNode(targetKey)),
    ),
  ]);

  const setterBody = t.blockStatement([
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(t.cloneNode(thisArg), t.cloneNode(targetKey)),
        t.identifier("v"),
      ),
    ),
  ]);

  let getter: t.ClassMethod | t.ClassPrivateMethod,
    setter: t.ClassMethod | t.ClassPrivateMethod;

  if (getterKey.type === "PrivateName") {
    getter = t.classPrivateMethod("get", getterKey, [], getterBody, isStatic);
    setter = t.classPrivateMethod(
      "set",
      setterKey as t.PrivateName,
      [t.identifier("v")],
      setterBody,
      isStatic,
    );
  } else {
    getter = t.classMethod(
      "get",
      getterKey,
      [],
      getterBody,
      isComputed,
      isStatic,
    );
    setter = t.classMethod(
      "set",
      setterKey as t.Expression,
      [t.identifier("v")],
      setterBody,
      isComputed,
      isStatic,
    );
  }

  element.insertAfter(setter);
  element.insertAfter(getter);
}

function extractProxyAccessorsFor(
  targetKey: t.PrivateName,
  version: DecoratorVersionKind,
): (t.FunctionExpression | t.ArrowFunctionExpression)[] {
  if (version !== "2023-11" && version !== "2023-05" && version !== "2023-01") {
    return [
      template.expression.ast`
        function () {
          return this.${t.cloneNode(targetKey)};
        }
      ` as t.FunctionExpression,
      template.expression.ast`
        function (value) {
          this.${t.cloneNode(targetKey)} = value;
        }
      ` as t.FunctionExpression,
    ];
  }
  return [
    template.expression.ast`
      o => o.${t.cloneNode(targetKey)}
    ` as t.ArrowFunctionExpression,
    template.expression.ast`
      (o, v) => o.${t.cloneNode(targetKey)} = v
    ` as t.ArrowFunctionExpression,
  ];
}

/**
 * Get the last element for the given computed key path.
 *
 * This function unwraps transparent wrappers and gets the last item when
 * the key is a SequenceExpression.
 *
 * @param {NodePath<t.Expression>} path The key of a computed class element
 * @returns {NodePath<t.Expression>} The simple completion result
 */
function getComputedKeyLastElement(
  path: NodePath<t.Expression>,
): NodePath<t.Expression> {
  path = skipTransparentExprWrappers(path);
  if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    return getComputedKeyLastElement(expressions[expressions.length - 1]);
  }
  return path;
}

/**
 * Get a memoiser of the computed key path.
 *
 * This function does not mutate AST. If the computed key is not a constant
 * expression, this function must be called after the key has been memoised.
 *
 * @param {NodePath<t.Expression>} path The key of a computed class element.
 * @returns {t.Expression} A clone of key if key is a constant expression,
 * otherwise a memoiser identifier.
 */
function getComputedKeyMemoiser(path: NodePath<t.Expression>): t.Expression {
  const element = getComputedKeyLastElement(path);
  if (element.isConstantExpression()) {
    return t.cloneNode(path.node);
  } else if (element.isIdentifier() && path.scope.hasUid(element.node.name)) {
    return t.cloneNode(path.node);
  } else if (
    element.isAssignmentExpression() &&
    element.get("left").isIdentifier()
  ) {
    return t.cloneNode(element.node.left as t.Identifier);
  } else {
    throw new Error(
      `Internal Error: the computed key ${path.toString()} has not yet been memoised.`,
    );
  }
}

/**
 * Prepend expressions to the computed key of the given field path.
 *
 * If the computed key is a sequence expression, this function will unwrap
 * the sequence expression for optimal output size.
 *
 * @param {t.Expression[]} expressions
 * @param {(NodePath<
 *     t.ClassMethod | t.ClassProperty | t.ClassAccessorProperty
 *   >)} fieldPath
 */
function prependExpressionsToComputedKey(
  expressions: t.Expression[],
  fieldPath: NodePath<
    t.ClassMethod | t.ClassProperty | t.ClassAccessorProperty
  >,
) {
  const key = fieldPath.get("key") as NodePath<t.Expression>;
  if (key.isSequenceExpression()) {
    expressions.push(...key.node.expressions);
  } else {
    expressions.push(key.node);
  }
  key.replaceWith(maybeSequenceExpression(expressions));
}

/**
 * Append expressions to the computed key of the given field path.
 *
 * If the computed key is a constant expression or uid reference, it
 * will prepend expressions before the comptued key. Otherwise it will
 * memoise the computed key to preserve its completion result.
 *
 * @param {t.Expression[]} expressions
 * @param {(NodePath<
 *     t.ClassMethod | t.ClassProperty | t.ClassAccessorProperty
 *   >)} fieldPath
 */
function appendExpressionsToComputedKey(
  expressions: t.Expression[],
  fieldPath: NodePath<
    t.ClassMethod | t.ClassProperty | t.ClassAccessorProperty
  >,
) {
  const key = fieldPath.get("key") as NodePath<t.Expression>;
  const completion = getComputedKeyLastElement(key);
  if (completion.isConstantExpression()) {
    prependExpressionsToComputedKey(expressions, fieldPath);
  } else {
    const scopeParent = key.scope.parent;
    const maybeAssignment = memoiseComputedKey(
      completion.node,
      scopeParent,
      scopeParent.generateUid("computedKey"),
    );
    if (!maybeAssignment) {
      // If the memoiseComputedKey returns undefined, the key is already a uid reference,
      // treat it as a constant expression and prepend expressions before it
      prependExpressionsToComputedKey(expressions, fieldPath);
    } else {
      const expressionSequence = [
        ...expressions,
        // preserve the completion result
        t.cloneNode(maybeAssignment.left),
      ];
      const completionParent = completion.parentPath;
      if (completionParent.isSequenceExpression()) {
        completionParent.pushContainer("expressions", expressionSequence);
      } else {
        completion.replaceWith(
          maybeSequenceExpression([
            t.cloneNode(maybeAssignment),
            ...expressionSequence,
          ]),
        );
      }
    }
  }
}

/**
 * Prepend expressions to the field initializer. If the initializer is not defined,
 * this function will wrap the last expression within a `void` unary expression.
 *
 * @param {t.Expression[]} expressions
 * @param {(NodePath<
 *     t.ClassProperty | t.ClassPrivateProperty | t.ClassAccessorProperty
 *   >)} fieldPath
 */
function prependExpressionsToFieldInitializer(
  expressions: t.Expression[],
  fieldPath: NodePath<
    t.ClassProperty | t.ClassPrivateProperty | t.ClassAccessorProperty
  >,
) {
  const initializer = fieldPath.get("value");
  if (initializer.node) {
    expressions.push(initializer.node);
  } else if (expressions.length > 0) {
    expressions[expressions.length - 1] = t.unaryExpression(
      "void",
      expressions[expressions.length - 1],
    );
  }
  initializer.replaceWith(maybeSequenceExpression(expressions));
}

function prependExpressionsToStaticBlock(
  expressions: t.Expression[],
  blockPath: NodePath<t.StaticBlock>,
) {
  blockPath.unshiftContainer(
    "body",
    t.expressionStatement(maybeSequenceExpression(expressions)),
  );
}

function prependExpressionsToConstructor(
  expressions: t.Expression[],
  constructorPath: NodePath<t.ClassMethod>,
) {
  constructorPath.node.body.body.unshift(
    t.expressionStatement(maybeSequenceExpression(expressions)),
  );
}

function isProtoInitCallExpression(
  expression: t.Expression,
  protoInitCall: t.Identifier,
) {
  return (
    t.isCallExpression(expression) &&
    t.isIdentifier(expression.callee, { name: protoInitCall.name })
  );
}

/**
 * Optimize super call and its following expressions
 *
 * @param {t.Expression[]} expressions Mutated by this function. The first element must by a super call
 * @param {t.Identifier} protoInitLocal The generated protoInit id
 * @returns optimized expression
 */
function optimizeSuperCallAndExpressions(
  expressions: t.Expression[],
  protoInitLocal: t.Identifier,
) {
  // Merge `super(), protoInit(this)` into `protoInit(super())`
  if (
    expressions.length >= 2 &&
    isProtoInitCallExpression(expressions[1], protoInitLocal)
  ) {
    const mergedSuperCall = t.callExpression(t.cloneNode(protoInitLocal), [
      expressions[0],
    ]);
    expressions.splice(0, 2, mergedSuperCall);
  }
  // Merge `protoInit(super()), this` into `protoInit(super())`
  if (
    expressions.length >= 2 &&
    t.isThisExpression(expressions[expressions.length - 1]) &&
    isProtoInitCallExpression(
      expressions[expressions.length - 2],
      protoInitLocal,
    )
  ) {
    expressions.splice(expressions.length - 1, 1);
  }
  return maybeSequenceExpression(expressions);
}

/**
 * Insert expressions immediately after super() and optimize the output if possible.
 * This function will preserve the completion result using the trailing this expression.
 *
 * @param {t.Expression[]} expressions
 * @param {NodePath<t.ClassMethod>} constructorPath
 * @param {t.Identifier} protoInitLocal The generated protoInit id
 * @returns
 */
function insertExpressionsAfterSuperCallAndOptimize(
  expressions: t.Expression[],
  constructorPath: NodePath<t.ClassMethod>,
  protoInitLocal: t.Identifier,
) {
  constructorPath.traverse({
    CallExpression: {
      exit(path) {
        if (!path.get("callee").isSuper()) return;
        const newNodes = [
          path.node,
          ...expressions.map(expr => t.cloneNode(expr)),
        ];
        // preserve completion result if super() is in an RHS or a return statement
        if (path.isCompletionRecord()) {
          newNodes.push(t.thisExpression());
        }
        path.replaceWith(
          optimizeSuperCallAndExpressions(newNodes, protoInitLocal),
        );

        path.skip();
      },
    },
    ClassMethod(path) {
      if (path.node.kind === "constructor") {
        path.skip();
      }
    },
  });
}

/**
 * Build a class constructor node from the given expressions. If the class is
 * derived, the constructor will call super() first to ensure that `this`
 * in the expressions work as expected.
 *
 * @param {t.Expression[]} expressions
 * @param {boolean} isDerivedClass
 * @returns The class constructor node
 */
function createConstructorFromExpressions(
  expressions: t.Expression[],
  isDerivedClass: boolean,
) {
  const body: t.Statement[] = [
    t.expressionStatement(maybeSequenceExpression(expressions)),
  ];
  if (isDerivedClass) {
    body.unshift(
      t.expressionStatement(
        t.callExpression(t.super(), [t.spreadElement(t.identifier("args"))]),
      ),
    );
  }
  return t.classMethod(
    "constructor",
    t.identifier("constructor"),
    isDerivedClass ? [t.restElement(t.identifier("args"))] : [],
    t.blockStatement(body),
  );
}

function createStaticBlockFromExpressions(expressions: t.Expression[]) {
  return t.staticBlock([
    t.expressionStatement(maybeSequenceExpression(expressions)),
  ]);
}

// 3 bits reserved to this (0-7)
const FIELD = 0;
const ACCESSOR = 1;
const METHOD = 2;
const GETTER = 3;
const SETTER = 4;

const STATIC_OLD_VERSION = 5; // Before 2023-05
const STATIC = 8; // 1 << 3
const DECORATORS_HAVE_THIS = 16; // 1 << 4

function getElementKind(element: NodePath<ClassDecoratableElement>): number {
  switch (element.node.type) {
    case "ClassProperty":
    case "ClassPrivateProperty":
      return FIELD;
    case "ClassAccessorProperty":
      return ACCESSOR;
    case "ClassMethod":
    case "ClassPrivateMethod":
      if (element.node.kind === "get") {
        return GETTER;
      } else if (element.node.kind === "set") {
        return SETTER;
      } else {
        return METHOD;
      }
  }
}

// Information about the decorators applied to an element
interface DecoratorInfo {
  // An array of applied decorators or a memoised identifier
  decoratorsArray: t.Identifier | t.ArrayExpression | t.Expression;
  decoratorsHaveThis: boolean;

  // The kind of the decorated value, matches the kind value passed to applyDecs
  kind: number;

  // whether or not the field is static
  isStatic: boolean;

  // The name of the decorator
  name: t.StringLiteral | t.Expression;

  privateMethods:
    | (t.FunctionExpression | t.ArrowFunctionExpression)[]
    | undefined;

  // The names of local variables that will be used/returned from the decoration
  locals: t.Identifier | t.Identifier[] | undefined;
}

/**
 * Sort decoration info in the application order:
 * - static non-fields
 * - instance non-fields
 * - static fields
 * - instance fields
 *
 * @param {DecoratorInfo[]} info
 * @returns {DecoratorInfo[]} Sorted decoration info
 */
function toSortedDecoratorInfo(info: DecoratorInfo[]): DecoratorInfo[] {
  return [
    ...info.filter(
      el => el.isStatic && el.kind >= ACCESSOR && el.kind <= SETTER,
    ),
    ...info.filter(
      el => !el.isStatic && el.kind >= ACCESSOR && el.kind <= SETTER,
    ),
    ...info.filter(el => el.isStatic && el.kind === FIELD),
    ...info.filter(el => !el.isStatic && el.kind === FIELD),
  ];
}

type GenerateDecorationListResult = {
  // The zipped decorators array that will be passed to generateDecorationExprs
  decs: t.Expression[];
  // Whether there are non-empty decorator this values
  haveThis: boolean;
};
/**
 * Zip decorators and decorator this values into an array
 *
 * @param {t.Expression[]} decorators
 * @param {((t.Expression | undefined)[])} decoratorsThis decorator this values
 * @param {DecoratorVersionKind} version
 * @returns {GenerateDecorationListResult}
 */
function generateDecorationList(
  decorators: t.Expression[],
  decoratorsThis: (t.Expression | undefined)[],
  version: DecoratorVersionKind,
): GenerateDecorationListResult {
  const decsCount = decorators.length;
  const haveOneThis = decoratorsThis.some(Boolean);
  const decs: t.Expression[] = [];
  for (let i = 0; i < decsCount; i++) {
    if (
      (version === "2023-11" ||
        (!process.env.BABEL_8_BREAKING && version === "2023-05")) &&
      haveOneThis
    ) {
      decs.push(
        decoratorsThis[i] || t.unaryExpression("void", t.numericLiteral(0)),
      );
    }
    decs.push(decorators[i]);
  }

  return { haveThis: haveOneThis, decs };
}

function generateDecorationExprs(
  decorationInfo: DecoratorInfo[],
  version: DecoratorVersionKind,
): t.ArrayExpression {
  return t.arrayExpression(
    decorationInfo.map(el => {
      let flag = el.kind;
      if (el.isStatic) {
        flag +=
          version === "2023-11" ||
          (!process.env.BABEL_8_BREAKING && version === "2023-05")
            ? STATIC
            : STATIC_OLD_VERSION;
      }
      if (el.decoratorsHaveThis) flag += DECORATORS_HAVE_THIS;

      return t.arrayExpression([
        el.decoratorsArray,
        t.numericLiteral(flag),
        el.name,
        ...(el.privateMethods || []),
      ]);
    }),
  );
}

function extractElementLocalAssignments(decorationInfo: DecoratorInfo[]) {
  const localIds: t.Identifier[] = [];

  for (const el of decorationInfo) {
    const { locals } = el;

    if (Array.isArray(locals)) {
      localIds.push(...locals);
    } else if (locals !== undefined) {
      localIds.push(locals);
    }
  }

  return localIds;
}

function addCallAccessorsFor(
  version: DecoratorVersionKind,
  element: NodePath,
  key: t.PrivateName,
  getId: t.Identifier,
  setId: t.Identifier,
  isStatic: boolean,
) {
  element.insertAfter(
    t.classPrivateMethod(
      "get",
      t.cloneNode(key),
      [],
      t.blockStatement([
        t.returnStatement(
          t.callExpression(
            t.cloneNode(getId),
            (process.env.BABEL_8_BREAKING || version === "2023-11") && isStatic
              ? []
              : [t.thisExpression()],
          ),
        ),
      ]),
      isStatic,
    ),
  );

  element.insertAfter(
    t.classPrivateMethod(
      "set",
      t.cloneNode(key),
      [t.identifier("v")],
      t.blockStatement([
        t.expressionStatement(
          t.callExpression(
            t.cloneNode(setId),
            (process.env.BABEL_8_BREAKING || version === "2023-11") && isStatic
              ? [t.identifier("v")]
              : [t.thisExpression(), t.identifier("v")],
          ),
        ),
      ]),
      isStatic,
    ),
  );
}

function movePrivateAccessor(
  element: NodePath<t.ClassPrivateMethod>,
  key: t.PrivateName,
  methodLocalVar: t.Identifier,
  isStatic: boolean,
) {
  let params: (t.Identifier | t.RestElement)[];
  let block: t.Statement[];

  if (element.node.kind === "set") {
    params = [t.identifier("v")];
    block = [
      t.expressionStatement(
        t.callExpression(methodLocalVar, [
          t.thisExpression(),
          t.identifier("v"),
        ]),
      ),
    ];
  } else {
    params = [];
    block = [
      t.returnStatement(t.callExpression(methodLocalVar, [t.thisExpression()])),
    ];
  }

  element.replaceWith(
    t.classPrivateMethod(
      element.node.kind,
      t.cloneNode(key),
      params,
      t.blockStatement(block),
      isStatic,
    ),
  );
}

function isClassDecoratableElementPath(
  path: NodePath<ClassElement>,
): path is NodePath<ClassDecoratableElement> {
  const { type } = path;

  return (
    type !== "TSDeclareMethod" &&
    type !== "TSIndexSignature" &&
    type !== "StaticBlock"
  );
}

function staticBlockToIIFE(block: t.StaticBlock) {
  return t.callExpression(
    t.arrowFunctionExpression([], t.blockStatement(block.body)),
    [],
  );
}

function staticBlockToFunctionClosure(block: t.StaticBlock) {
  return t.functionExpression(null, [], t.blockStatement(block.body));
}

function fieldInitializerToClosure(value: t.Expression) {
  return t.functionExpression(
    null,
    [],
    t.blockStatement([t.returnStatement(value)]),
  );
}

function maybeSequenceExpression(exprs: t.Expression[]) {
  if (exprs.length === 0) return t.unaryExpression("void", t.numericLiteral(0));
  if (exprs.length === 1) return exprs[0];
  return t.sequenceExpression(exprs);
}

/**
 * Create FunctionExpression from a ClassPrivateMethod.
 * The returned FunctionExpression node takes ownership of the private method's body and params.
 *
 * @param {t.ClassPrivateMethod} node
 * @returns
 */
function createFunctionExpressionFromPrivateMethod(node: t.ClassPrivateMethod) {
  const { params, body, generator: isGenerator, async: isAsync } = node;
  return t.functionExpression(
    undefined,
    // @ts-expect-error todo: Improve typings: TSParameterProperty is only allowed in constructor
    params,
    body,
    isGenerator,
    isAsync,
  );
}

function createSetFunctionNameCall(
  state: PluginPass,
  className: t.Identifier | t.StringLiteral,
) {
  return t.callExpression(state.addHelper("setFunctionName"), [
    t.thisExpression(),
    className,
  ]);
}

function createToPropertyKeyCall(state: PluginPass, propertyKey: t.Expression) {
  return t.callExpression(state.addHelper("toPropertyKey"), [propertyKey]);
}

function createPrivateBrandCheckClosure(brandName: t.PrivateName) {
  return t.arrowFunctionExpression(
    [t.identifier("_")],
    t.binaryExpression("in", t.cloneNode(brandName), t.identifier("_")),
  );
}

// Check if the expression does not reference function-specific
// context or the given identifier name.
// `true` means "maybe" and `false` means "no".
function usesFunctionContextOrYieldAwait(expression: t.Node) {
  try {
    t.traverseFast(expression, node => {
      if (
        t.isThisExpression(node) ||
        t.isSuper(node) ||
        t.isYieldExpression(node) ||
        t.isAwaitExpression(node) ||
        t.isIdentifier(node, { name: "arguments" }) ||
        (t.isMetaProperty(node) && node.meta.name !== "import")
      ) {
        // TODO: Add early return support to t.traverseFast
        throw null;
      }
    });
    return false;
  } catch {
    return true;
  }
}

function usesPrivateField(expression: t.Node) {
  try {
    t.traverseFast(expression, node => {
      if (t.isPrivateName(node)) {
        // TODO: Add early return support to t.traverseFast
        throw null;
      }
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Convert a non-computed class element to its equivalent computed form.
 *
 * This function is to provide a decorator evaluation storage from non-computed
 * class elements.
 *
 * @param {(NodePath<t.ClassProperty | t.ClassMethod>)} path A non-computed class property or method
 */
function convertToComputedKey(path: NodePath<t.ClassProperty | t.ClassMethod>) {
  const { node } = path;
  node.computed = true;
  if (t.isIdentifier(node.key)) {
    node.key = t.stringLiteral(node.key.name);
  }
}

function hasInstancePrivateAccess(path: NodePath, privateNames: string[]) {
  let containsInstancePrivateAccess = false;
  if (privateNames.length > 0) {
    const privateNameVisitor = privateNameVisitorFactory<
      PrivateNameVisitorState<null>,
      null
    >({
      PrivateName(path, state) {
        if (state.privateNamesMap.has(path.node.id.name)) {
          containsInstancePrivateAccess = true;
          path.stop();
        }
      },
    });
    const privateNamesMap = new Map<string, null>();
    for (const name of privateNames) {
      privateNamesMap.set(name, null);
    }
    path.traverse(privateNameVisitor, {
      privateNamesMap: privateNamesMap,
    });
  }
  return containsInstancePrivateAccess;
}

function checkPrivateMethodUpdateError(
  path: NodePath<t.Class>,
  decoratedPrivateMethods: Set<string>,
) {
  const privateNameVisitor = privateNameVisitorFactory<
    PrivateNameVisitorState<null>,
    null
  >({
    PrivateName(path, state) {
      if (!state.privateNamesMap.has(path.node.id.name)) return;

      const parentPath = path.parentPath;
      const parentParentPath = parentPath.parentPath;

      if (
        // this.bar().#x = 123;
        (parentParentPath.node.type === "AssignmentExpression" &&
          parentParentPath.node.left === parentPath.node) ||
        // this.#x++;
        parentParentPath.node.type === "UpdateExpression" ||
        // ([...this.#x] = foo);
        parentParentPath.node.type === "RestElement" ||
        // ([this.#x] = foo);
        parentParentPath.node.type === "ArrayPattern" ||
        // ({ a: this.#x } = bar);
        (parentParentPath.node.type === "ObjectProperty" &&
          parentParentPath.node.value === parentPath.node &&
          parentParentPath.parentPath.type === "ObjectPattern") ||
        // for (this.#x of []);
        (parentParentPath.node.type === "ForOfStatement" &&
          parentParentPath.node.left === parentPath.node)
      ) {
        throw path.buildCodeFrameError(
          `Decorated private methods are read-only, but "#${path.node.id.name}" is updated via this expression.`,
        );
      }
    },
  });
  const privateNamesMap = new Map<string, null>();
  for (const name of decoratedPrivateMethods) {
    privateNamesMap.set(name, null);
  }
  path.traverse(privateNameVisitor, {
    privateNamesMap: privateNamesMap,
  });
}

function transformClass(
  path: NodePath<t.Class>,
  state: PluginPass,
  constantSuper: boolean,
  ignoreFunctionLength: boolean,
  className: string | t.Identifier | t.StringLiteral | undefined,
  propertyVisitor: Visitor<PluginPass>,
  version: DecoratorVersionKind,
): NodePath {
  const body = path.get("body.body");

  const classDecorators = path.node.decorators;
  let hasElementDecorators = false;
  let hasComputedKeysSideEffects = false;
  let elemDecsUseFnContext = false;

  const generateClassPrivateUid = createLazyPrivateUidGeneratorForClass(path);

  const classAssignments: t.AssignmentExpression[] = [];
  const scopeParent: Scope = path.scope.parent;
  const memoiseExpression = (
    expression: t.Expression,
    hint: string,
    assignments: t.AssignmentExpression[],
  ) => {
    const localEvaluatedId = generateLetUidIdentifier(scopeParent, hint);
    assignments.push(t.assignmentExpression("=", localEvaluatedId, expression));
    return t.cloneNode(localEvaluatedId);
  };

  let protoInitLocal: t.Identifier;
  let staticInitLocal: t.Identifier;
  const instancePrivateNames: string[] = [];
  // Iterate over the class to see if we need to decorate it, and also to
  // transform simple auto accessors which are not decorated, and handle inferred
  // class name when the initializer of the class field is a class expression
  for (const element of body) {
    if (!isClassDecoratableElementPath(element)) {
      continue;
    }

    const elementNode = element.node;

    if (!elementNode.static && t.isPrivateName(elementNode.key)) {
      instancePrivateNames.push(elementNode.key.id.name);
    }

    if (isDecorated(elementNode)) {
      switch (elementNode.type) {
        case "ClassProperty":
          // @ts-expect-error todo: propertyVisitor.ClassProperty should be callable. Improve typings.
          propertyVisitor.ClassProperty(
            element as NodePath<t.ClassProperty>,
            state,
          );
          break;
        case "ClassPrivateProperty":
          // @ts-expect-error todo: propertyVisitor.ClassPrivateProperty should be callable. Improve typings.
          propertyVisitor.ClassPrivateProperty(
            element as NodePath<t.ClassPrivateProperty>,
            state,
          );
          break;
        case "ClassAccessorProperty":
          // @ts-expect-error todo: propertyVisitor.ClassAccessorProperty should be callable. Improve typings.
          propertyVisitor.ClassAccessorProperty(
            element as NodePath<t.ClassAccessorProperty>,
            state,
          );
          if (version === "2023-11") {
            break;
          }
        /* fallthrough */
        default:
          if (elementNode.static) {
            staticInitLocal ??= generateLetUidIdentifier(
              scopeParent,
              "initStatic",
            );
          } else {
            protoInitLocal ??= generateLetUidIdentifier(
              scopeParent,
              "initProto",
            );
          }
          break;
      }
      hasElementDecorators = true;
      elemDecsUseFnContext ||= elementNode.decorators.some(
        usesFunctionContextOrYieldAwait,
      );
    } else if (elementNode.type === "ClassAccessorProperty") {
      // @ts-expect-error todo: propertyVisitor.ClassAccessorProperty should be callable. Improve typings.
      propertyVisitor.ClassAccessorProperty(
        element as NodePath<t.ClassAccessorProperty>,
        state,
      );
      const { key, value, static: isStatic, computed } = elementNode;

      const newId = generateClassPrivateUid();
      const newField = generateClassProperty(newId, value, isStatic);
      const keyPath = element.get("key");
      const [newPath] = element.replaceWith(newField);

      let getterKey, setterKey;
      if (computed && !keyPath.isConstantExpression()) {
        getterKey = memoiseComputedKey(
          createToPropertyKeyCall(state, key as t.Expression),
          scopeParent,
          scopeParent.generateUid("computedKey"),
        )!;
        setterKey = t.cloneNode(getterKey.left as t.Identifier);
      } else {
        getterKey = t.cloneNode(key);
        setterKey = t.cloneNode(key);
      }

      addProxyAccessorsFor(
        path.node.id,
        newPath,
        getterKey,
        setterKey,
        newId,
        computed,
        isStatic,
        version,
      );
    }

    if ("computed" in element.node && element.node.computed) {
      hasComputedKeysSideEffects ||= !scopeParent.isStatic(element.node.key);
    }
  }

  if (!classDecorators && !hasElementDecorators) {
    // If nothing is decorated and no assignments inserted, return
    return;
  }

  const elementDecoratorInfo: DecoratorInfo[] = [];

  let constructorPath: NodePath<t.ClassMethod> | undefined;
  const decoratedPrivateMethods = new Set<string>();

  let classInitLocal: t.Identifier, classIdLocal: t.Identifier;
  let decoratorReceiverId: t.Identifier | null = null;

  // Memoise the this value `a.b` of decorator member expressions `@a.b.dec`,
  type HandleDecoratorExpressionsResult = {
    // whether the whole decorator list requires memoisation
    hasSideEffects: boolean;
    usesFnContext: boolean;
    // the this value of each decorator if applicable
    decoratorsThis: (t.Expression | undefined)[];
  };
  function handleDecoratorExpressions(
    expressions: t.Expression[],
  ): HandleDecoratorExpressionsResult {
    let hasSideEffects = false;
    let usesFnContext = false;
    const decoratorsThis: (t.Expression | null)[] = [];
    for (const expression of expressions) {
      let object;
      if (
        (version === "2023-11" ||
          (!process.env.BABEL_8_BREAKING && version === "2023-05")) &&
        t.isMemberExpression(expression)
      ) {
        if (t.isSuper(expression.object)) {
          object = t.thisExpression();
        } else if (scopeParent.isStatic(expression.object)) {
          object = t.cloneNode(expression.object);
        } else {
          decoratorReceiverId ??= generateLetUidIdentifier(scopeParent, "obj");
          object = t.assignmentExpression(
            "=",
            t.cloneNode(decoratorReceiverId),
            expression.object,
          );
          expression.object = t.cloneNode(decoratorReceiverId);
        }
      }
      decoratorsThis.push(object);
      hasSideEffects ||= !scopeParent.isStatic(expression);
      usesFnContext ||= usesFunctionContextOrYieldAwait(expression);
    }
    return { hasSideEffects, usesFnContext, decoratorsThis };
  }

  const willExtractSomeElemDecs =
    hasComputedKeysSideEffects ||
    (process.env.BABEL_8_BREAKING
      ? elemDecsUseFnContext
      : elemDecsUseFnContext || version !== "2023-11");

  let needsDeclaraionForClassBinding = false;
  let classDecorationsFlag = 0;
  let classDecorations: t.Expression[] = [];
  let classDecorationsId: t.Identifier;
  let computedKeyAssignments: t.AssignmentExpression[] = [];
  if (classDecorators) {
    classInitLocal = generateLetUidIdentifier(scopeParent, "initClass");
    needsDeclaraionForClassBinding = path.isClassDeclaration();
    ({ id: classIdLocal, path } = replaceClassWithVar(path, className));

    path.node.decorators = null;

    const decoratorExpressions = classDecorators.map(el => el.expression);
    const classDecsUsePrivateName = decoratorExpressions.some(usesPrivateField);
    const { hasSideEffects, decoratorsThis } =
      handleDecoratorExpressions(decoratorExpressions);

    const { haveThis, decs } = generateDecorationList(
      decoratorExpressions,
      decoratorsThis,
      version,
    );
    classDecorationsFlag = haveThis ? 1 : 0;
    classDecorations = decs;

    if (
      (hasSideEffects && willExtractSomeElemDecs) ||
      classDecsUsePrivateName
    ) {
      classDecorationsId = memoiseExpression(
        t.arrayExpression(classDecorations),
        "classDecs",
        classAssignments,
      );
    }

    if (!hasElementDecorators) {
      // Sync body paths as non-decorated computed accessors have been transpiled
      // to getter-setter pairs.
      for (const element of path.get("body.body")) {
        const { node } = element;
        const isComputed = "computed" in node && node.computed;
        if (isComputed) {
          if (element.isClassProperty({ static: true })) {
            if (!element.get("key").isConstantExpression()) {
              const key = (node as t.ClassProperty).key;
              const maybeAssignment = memoiseComputedKey(
                key,
                scopeParent,
                scopeParent.generateUid("computedKey"),
              );
              if (maybeAssignment != null) {
                // If it is a static computed field within a decorated class, we move the computed key
                // into `computedKeyAssignments` which will be then moved into the non-static class,
                // to ensure that the evaluation order and private environment are correct
                node.key = t.cloneNode(maybeAssignment.left);
                computedKeyAssignments.push(maybeAssignment);
              }
            }
          } else if (computedKeyAssignments.length > 0) {
            prependExpressionsToComputedKey(
              computedKeyAssignments,
              element as NodePath<ClassElementCanHaveComputedKeys>,
            );
            computedKeyAssignments = [];
          }
        }
      }
    }
  } else {
    if (!path.node.id) {
      path.node.id = path.scope.generateUidIdentifier("Class");
    }
    classIdLocal = t.cloneNode(path.node.id);
  }

  let lastInstancePrivateName: t.PrivateName;
  let needsInstancePrivateBrandCheck = false;

  let fieldInitializerExpressions = [];
  let staticFieldInitializerExpressions: t.Expression[] = [];

  if (hasElementDecorators) {
    if (protoInitLocal) {
      const protoInitCall = t.callExpression(t.cloneNode(protoInitLocal), [
        t.thisExpression(),
      ]);
      fieldInitializerExpressions.push(protoInitCall);
    }
    for (const element of body) {
      if (!isClassDecoratableElementPath(element)) {
        if (
          staticFieldInitializerExpressions.length > 0 &&
          element.isStaticBlock()
        ) {
          prependExpressionsToStaticBlock(
            staticFieldInitializerExpressions,
            element,
          );
          staticFieldInitializerExpressions = [];
        }
        continue;
      }

      const { node } = element;
      const decorators = node.decorators;

      const hasDecorators = !!decorators?.length;

      const isComputed = "computed" in node && node.computed;

      let name = "computedKey";

      if (node.key.type === "PrivateName") {
        name = node.key.id.name;
      } else if (!isComputed && node.key.type === "Identifier") {
        name = node.key.name;
      }
      let decoratorsArray: t.Identifier | t.ArrayExpression | t.Expression;
      let decoratorsHaveThis;

      if (hasDecorators) {
        const decoratorExpressions = decorators.map(d => d.expression);
        const { hasSideEffects, usesFnContext, decoratorsThis } =
          handleDecoratorExpressions(decoratorExpressions);
        const { decs, haveThis } = generateDecorationList(
          decoratorExpressions,
          decoratorsThis,
          version,
        );
        decoratorsHaveThis = haveThis;
        decoratorsArray = decs.length === 1 ? decs[0] : t.arrayExpression(decs);
        if (usesFnContext || (hasSideEffects && willExtractSomeElemDecs)) {
          decoratorsArray = memoiseExpression(
            decoratorsArray,
            name + "Decs",
            computedKeyAssignments,
          );
        }
      }

      if (isComputed) {
        if (!element.get("key").isConstantExpression()) {
          const key = node.key as t.Expression;
          const maybeAssignment = memoiseComputedKey(
            hasDecorators ? createToPropertyKeyCall(state, key) : key,
            scopeParent,
            scopeParent.generateUid("computedKey"),
          );
          if (maybeAssignment != null) {
            // If it is a static computed field within a decorated class, we move the computed key
            // into `computedKeyAssignments` which will be then moved into the non-static class,
            // to ensure that the evaluation order and private environment are correct
            if (classDecorators && element.isClassProperty({ static: true })) {
              node.key = t.cloneNode(maybeAssignment.left);
              computedKeyAssignments.push(maybeAssignment);
            } else {
              node.key = maybeAssignment;
            }
          }
        }
      }

      const { key, static: isStatic } = node;

      const isPrivate = key.type === "PrivateName";

      const kind = getElementKind(element);

      if (isPrivate && !isStatic) {
        if (hasDecorators) {
          needsInstancePrivateBrandCheck = true;
        }
        if (t.isClassPrivateProperty(node) || !lastInstancePrivateName) {
          lastInstancePrivateName = key;
        }
      }

      if (element.isClassMethod({ kind: "constructor" })) {
        constructorPath = element;
      }

      let locals: t.Identifier[];
      if (hasDecorators) {
        let privateMethods: Array<
          t.FunctionExpression | t.ArrowFunctionExpression
        >;

        let nameExpr: t.Expression;

        if (isComputed) {
          nameExpr = getComputedKeyMemoiser(
            element.get("key") as NodePath<t.Expression>,
          );
        } else if (key.type === "PrivateName") {
          nameExpr = t.stringLiteral(key.id.name);
        } else if (key.type === "Identifier") {
          nameExpr = t.stringLiteral(key.name);
        } else {
          nameExpr = t.cloneNode(key as t.Expression);
        }

        if (kind === ACCESSOR) {
          const { value } = element.node as t.ClassAccessorProperty;

          const params: t.Expression[] =
            (process.env.BABEL_8_BREAKING || version === "2023-11") && isStatic
              ? []
              : [t.thisExpression()];

          if (value) {
            params.push(t.cloneNode(value));
          }

          const newId = generateClassPrivateUid();
          const newFieldInitId = generateLetUidIdentifier(
            scopeParent,
            `init_${name}`,
          );
          const newValue = t.callExpression(
            t.cloneNode(newFieldInitId),
            params,
          );

          const newField = generateClassProperty(newId, newValue, isStatic);
          const [newPath] = element.replaceWith(newField);

          if (isPrivate) {
            privateMethods = extractProxyAccessorsFor(newId, version);

            const getId = generateLetUidIdentifier(scopeParent, `get_${name}`);
            const setId = generateLetUidIdentifier(scopeParent, `set_${name}`);

            addCallAccessorsFor(version, newPath, key, getId, setId, isStatic);

            locals = [newFieldInitId, getId, setId];
          } else {
            addProxyAccessorsFor(
              path.node.id,
              newPath,
              t.cloneNode(key),
              t.isAssignmentExpression(key)
                ? t.cloneNode(key.left as t.Identifier)
                : t.cloneNode(key),
              newId,
              isComputed,
              isStatic,
              version,
            );
            locals = [newFieldInitId];
          }
        } else if (kind === FIELD) {
          const initId = generateLetUidIdentifier(scopeParent, `init_${name}`);
          const valuePath = (
            element as NodePath<t.ClassProperty | t.ClassPrivateProperty>
          ).get("value");

          const args: t.Expression[] =
            (process.env.BABEL_8_BREAKING || version === "2023-11") && isStatic
              ? []
              : [t.thisExpression()];
          if (valuePath.node) args.push(valuePath.node);

          valuePath.replaceWith(t.callExpression(t.cloneNode(initId), args));

          locals = [initId];

          if (isPrivate) {
            privateMethods = extractProxyAccessorsFor(key, version);
          }
        } else if (isPrivate) {
          const callId = generateLetUidIdentifier(scopeParent, `call_${name}`);
          locals = [callId];

          const replaceSupers = new ReplaceSupers({
            constantSuper,
            methodPath: element as NodePath<t.ClassPrivateMethod>,
            objectRef: classIdLocal,
            superRef: path.node.superClass,
            file: state.file,
            refToPreserve: classIdLocal,
          });

          replaceSupers.replace();

          privateMethods = [
            createFunctionExpressionFromPrivateMethod(
              element.node as t.ClassPrivateMethod,
            ),
          ];

          if (kind === GETTER || kind === SETTER) {
            movePrivateAccessor(
              element as NodePath<t.ClassPrivateMethod>,
              t.cloneNode(key),
              t.cloneNode(callId),
              isStatic,
            );
          } else {
            const node = element.node as t.ClassPrivateMethod;

            // Unshift
            path.node.body.body.unshift(
              t.classPrivateProperty(key, t.cloneNode(callId), [], node.static),
            );

            decoratedPrivateMethods.add(key.id.name);

            element.remove();
          }
        }

        elementDecoratorInfo.push({
          kind,
          decoratorsArray,
          decoratorsHaveThis,
          name: nameExpr,
          isStatic,
          privateMethods,
          locals,
        });

        if (element.node) {
          element.node.decorators = null;
        }
      }

      if (isComputed && computedKeyAssignments.length > 0) {
        if (classDecorators && element.isClassProperty({ static: true })) {
          // If the class is decorated, we don't insert computedKeyAssignments here
          // because any non-static computed elements defined after it will be moved
          // into the non-static class, so they will be evaluated before the key of
          // this field. At this momemnt, its key must be either a constant expression
          // or a uid reference which has been assigned _within_ the non-static class.
        } else {
          prependExpressionsToComputedKey(
            computedKeyAssignments,
            (kind === ACCESSOR
              ? element.getNextSibling() // the transpiled getter of the accessor property
              : element) as NodePath<ClassElementCanHaveComputedKeys>,
          );
          computedKeyAssignments = [];
        }
      }

      if (
        fieldInitializerExpressions.length > 0 &&
        !isStatic &&
        (kind === FIELD || kind === ACCESSOR)
      ) {
        prependExpressionsToFieldInitializer(
          fieldInitializerExpressions,
          element as NodePath<t.ClassProperty | t.ClassPrivateProperty>,
        );
        fieldInitializerExpressions = [];
      }

      if (
        staticFieldInitializerExpressions.length > 0 &&
        isStatic &&
        (kind === FIELD || kind === ACCESSOR)
      ) {
        prependExpressionsToFieldInitializer(
          staticFieldInitializerExpressions,
          element as NodePath<t.ClassProperty | t.ClassPrivateProperty>,
        );
        staticFieldInitializerExpressions = [];
      }

      if (hasDecorators && version === "2023-11") {
        if (kind === FIELD || kind === ACCESSOR) {
          const initExtraId = generateLetUidIdentifier(
            scopeParent,
            `init_extra_${name}`,
          );
          locals.push(initExtraId);
          const initExtraCall = t.callExpression(
            t.cloneNode(initExtraId),
            isStatic ? [] : [t.thisExpression()],
          );
          if (!isStatic) {
            fieldInitializerExpressions.push(initExtraCall);
          } else {
            staticFieldInitializerExpressions.push(initExtraCall);
          }
        }
      }
    }
  }

  if (computedKeyAssignments.length > 0) {
    const elements = path.get("body.body");
    let lastComputedElement: NodePath<ClassElementCanHaveComputedKeys>;
    for (let i = elements.length - 1; i >= 0; i--) {
      const path = elements[i];
      const node = path.node as ClassElementCanHaveComputedKeys;
      if (node.computed) {
        if (classDecorators && t.isClassProperty(node, { static: true })) {
          continue;
        }
        lastComputedElement = path as NodePath<ClassElementCanHaveComputedKeys>;
        break;
      }
    }
    if (lastComputedElement != null) {
      appendExpressionsToComputedKey(
        computedKeyAssignments,
        lastComputedElement,
      );
      computedKeyAssignments = [];
    } else {
      // If there is no computed key, we will try to convert the first non-computed
      // class element into a computed key and insert assignments there. This will
      // be done after we handle the class elements split when the class is decorated.
    }
  }

  if (fieldInitializerExpressions.length > 0) {
    const isDerivedClass = !!path.node.superClass;
    if (constructorPath) {
      if (isDerivedClass) {
        insertExpressionsAfterSuperCallAndOptimize(
          fieldInitializerExpressions,
          constructorPath,
          protoInitLocal,
        );
      } else {
        prependExpressionsToConstructor(
          fieldInitializerExpressions,
          constructorPath,
        );
      }
    } else {
      path.node.body.body.unshift(
        createConstructorFromExpressions(
          fieldInitializerExpressions,
          isDerivedClass,
        ),
      );
    }
    fieldInitializerExpressions = [];
  }

  if (staticFieldInitializerExpressions.length > 0) {
    path.node.body.body.push(
      createStaticBlockFromExpressions(staticFieldInitializerExpressions),
    );
    staticFieldInitializerExpressions = [];
  }

  const sortedElementDecoratorInfo =
    toSortedDecoratorInfo(elementDecoratorInfo);

  const elementDecorations = generateDecorationExprs(
    process.env.BABEL_8_BREAKING || version === "2023-11"
      ? elementDecoratorInfo
      : sortedElementDecoratorInfo,
    version,
  );

  const elementLocals: t.Identifier[] = extractElementLocalAssignments(
    sortedElementDecoratorInfo,
  );

  if (protoInitLocal) {
    elementLocals.push(protoInitLocal);
  }

  if (staticInitLocal) {
    elementLocals.push(staticInitLocal);
  }

  const classLocals: t.Identifier[] = [];
  let classInitInjected = false;
  const classInitCall =
    classInitLocal && t.callExpression(t.cloneNode(classInitLocal), []);

  let originalClassPath = path;
  const originalClass = path.node;

  const staticClosures: t.AssignmentExpression[] = [];
  if (classDecorators) {
    classLocals.push(classIdLocal, classInitLocal);
    const statics: (
      | t.ClassProperty
      | t.ClassPrivateProperty
      | t.ClassPrivateMethod
    )[] = [];
    path.get("body.body").forEach(element => {
      // Static blocks cannot be compiled to "instance blocks", but we can inline
      // them as IIFEs in the next property.
      if (element.isStaticBlock()) {
        if (hasInstancePrivateAccess(element, instancePrivateNames)) {
          const staticBlockClosureId = memoiseExpression(
            staticBlockToFunctionClosure(element.node),
            "staticBlock",
            staticClosures,
          );
          staticFieldInitializerExpressions.push(
            t.callExpression(
              t.memberExpression(staticBlockClosureId, t.identifier("call")),
              [t.thisExpression()],
            ),
          );
        } else {
          staticFieldInitializerExpressions.push(
            staticBlockToIIFE(element.node),
          );
        }
        element.remove();
        return;
      }

      if (
        (element.isClassProperty() || element.isClassPrivateProperty()) &&
        element.node.static
      ) {
        const valuePath = (
          element as NodePath<t.ClassProperty | t.ClassPrivateProperty>
        ).get("value");
        if (hasInstancePrivateAccess(valuePath, instancePrivateNames)) {
          const fieldValueClosureId = memoiseExpression(
            fieldInitializerToClosure(valuePath.node),
            "fieldValue",
            staticClosures,
          );
          valuePath.replaceWith(
            t.callExpression(
              t.memberExpression(fieldValueClosureId, t.identifier("call")),
              [t.thisExpression()],
            ),
          );
        }
        if (staticFieldInitializerExpressions.length > 0) {
          prependExpressionsToFieldInitializer(
            staticFieldInitializerExpressions,
            element,
          );
          staticFieldInitializerExpressions = [];
        }
        element.node.static = false;
        statics.push(element.node);
        element.remove();
      } else if (element.isClassPrivateMethod({ static: true })) {
        // At this moment the element must not have decorators, so any private name
        // within the element must come from either params or body
        if (hasInstancePrivateAccess(element, instancePrivateNames)) {
          const replaceSupers = new ReplaceSupers({
            constantSuper,
            methodPath: element,
            objectRef: classIdLocal,
            superRef: path.node.superClass,
            file: state.file,
            refToPreserve: classIdLocal,
          });

          replaceSupers.replace();

          const privateMethodDelegateId = memoiseExpression(
            createFunctionExpressionFromPrivateMethod(element.node),
            element.get("key.id").node.name,
            staticClosures,
          );

          if (ignoreFunctionLength) {
            element.node.params = [t.restElement(t.identifier("arg"))];
            element.node.body = t.blockStatement([
              t.returnStatement(
                t.callExpression(
                  t.memberExpression(
                    privateMethodDelegateId,
                    t.identifier("apply"),
                  ),
                  [t.thisExpression(), t.identifier("arg")],
                ),
              ),
            ]);
          } else {
            element.node.params = element.node.params.map((p, i) => {
              if (t.isRestElement(p)) {
                return t.restElement(t.identifier("arg"));
              } else {
                return t.identifier("_" + i);
              }
            });
            element.node.body = t.blockStatement([
              t.returnStatement(
                t.callExpression(
                  t.memberExpression(
                    privateMethodDelegateId,
                    t.identifier("apply"),
                  ),
                  [t.thisExpression(), t.identifier("arguments")],
                ),
              ),
            ]);
          }
        }
        element.node.static = false;
        statics.push(element.node);
        element.remove();
      }
    });

    if (statics.length > 0 || staticFieldInitializerExpressions.length > 0) {
      const staticsClass = template.expression.ast`
        class extends ${state.addHelper("identity")} {}
      ` as t.ClassExpression;
      staticsClass.body.body = [
        // Insert the original class to a computed key of the wrapper so that
        // 1) they share the same function context with the wrapper class
        // 2) the memoisation of static computed field is evaluated before they
        //    are referenced in the wrapper class keys
        // Note that any static elements of the wrapper class can not be accessed
        // in the user land, so we don't have to remove the temporary class field.
        t.classProperty(
          t.toExpression(originalClass),
          undefined,
          undefined,
          undefined,
          /* computed */ true,
          /* static */ true,
        ),
        ...statics,
      ];

      const constructorBody: t.Expression[] = [];

      const newExpr = t.newExpression(staticsClass, []);

      if (staticFieldInitializerExpressions.length > 0) {
        constructorBody.push(...staticFieldInitializerExpressions);
      }
      if (classInitCall) {
        classInitInjected = true;
        constructorBody.push(classInitCall);
      }
      if (constructorBody.length > 0) {
        constructorBody.unshift(
          t.callExpression(t.super(), [t.cloneNode(classIdLocal)]),
        );

        // set isDerivedClass to false as we have already prepended super call
        staticsClass.body.body.push(
          createConstructorFromExpressions(
            constructorBody,
            /* isDerivedClass */ false,
          ),
        );
      } else {
        newExpr.arguments.push(t.cloneNode(classIdLocal));
      }

      const [newPath] = path.replaceWith(newExpr);

      // update originalClassPath according to the new AST
      originalClassPath = (
        newPath.get("callee").get("body") as NodePath<t.ClassBody>
      )
        .get("body")[0]
        .get("key");
    }
  }
  if (!classInitInjected && classInitCall) {
    path.node.body.body.push(
      t.staticBlock([t.expressionStatement(classInitCall)]),
    );
  }

  let { superClass } = originalClass;
  if (
    superClass &&
    (process.env.BABEL_8_BREAKING ||
      version === "2023-11" ||
      version === "2023-05")
  ) {
    const id = path.scope.maybeGenerateMemoised(superClass);
    if (id) {
      originalClass.superClass = t.assignmentExpression("=", id, superClass);
      superClass = id;
    }
  }

  const applyDecoratorWrapper = t.staticBlock([]);
  originalClass.body.body.unshift(applyDecoratorWrapper);
  const applyDecsBody = applyDecoratorWrapper.body;
  if (computedKeyAssignments.length > 0) {
    const elements = originalClassPath.get("body.body");
    let firstPublicElement: NodePath<t.ClassProperty | t.ClassMethod>;
    for (const path of elements) {
      if (
        (path.isClassProperty() || path.isClassMethod()) &&
        (path.node as t.ClassMethod).kind !== "constructor"
      ) {
        firstPublicElement = path;
        break;
      }
    }
    if (firstPublicElement != null) {
      // Convert its key to a computed one to host the decorator evaluations.
      convertToComputedKey(firstPublicElement);
      prependExpressionsToComputedKey(
        computedKeyAssignments,
        firstPublicElement,
      );
    } else {
      // When there is no public class elements, we inject a temporary computed
      // field whose key will host the decorator evaluations. The field will be
      // deleted immediately after it is defiend.
      originalClass.body.body.unshift(
        t.classProperty(
          t.sequenceExpression([
            ...computedKeyAssignments,
            t.stringLiteral("_"),
          ]),
          undefined,
          undefined,
          undefined,
          /* computed */ true,
          /* static */ true,
        ),
      );
      applyDecsBody.push(
        t.expressionStatement(
          t.unaryExpression(
            "delete",
            t.memberExpression(t.thisExpression(), t.identifier("_")),
          ),
        ),
      );
    }
    computedKeyAssignments = [];
  }

  applyDecsBody.push(
    t.expressionStatement(
      createLocalsAssignment(
        elementLocals,
        classLocals,
        elementDecorations,
        classDecorationsId ?? t.arrayExpression(classDecorations),
        t.numericLiteral(classDecorationsFlag),
        needsInstancePrivateBrandCheck ? lastInstancePrivateName : null,
        typeof className === "object" ? className : undefined,
        t.cloneNode(superClass),
        state,
        version,
      ),
    ),
  );
  if (staticInitLocal) {
    applyDecsBody.push(
      t.expressionStatement(
        t.callExpression(t.cloneNode(staticInitLocal), [t.thisExpression()]),
      ),
    );
  }
  if (staticClosures.length > 0) {
    applyDecsBody.push(
      ...staticClosures.map(expr => t.expressionStatement(expr)),
    );
  }

  // When path is a ClassExpression, path.insertBefore will convert `path`
  // into a SequenceExpression
  path.insertBefore(classAssignments.map(expr => t.expressionStatement(expr)));

  if (needsDeclaraionForClassBinding) {
    path.insertBefore(
      t.variableDeclaration("let", [
        t.variableDeclarator(t.cloneNode(classIdLocal)),
      ]),
    );
  }

  if (decoratedPrivateMethods.size > 0) {
    checkPrivateMethodUpdateError(path, decoratedPrivateMethods);
  }

  // Recrawl the scope to make sure new identifiers are properly synced
  path.scope.crawl();

  return path;
}

function createLocalsAssignment(
  elementLocals: t.Identifier[],
  classLocals: t.Identifier[],
  elementDecorations: t.ArrayExpression | t.Identifier,
  classDecorations: t.ArrayExpression | t.Identifier,
  classDecorationsFlag: t.NumericLiteral,
  maybePrivateBrandName: t.PrivateName | null,
  setClassName: t.Identifier | t.StringLiteral | undefined,
  superClass: null | t.Expression,
  state: PluginPass,
  version: DecoratorVersionKind,
) {
  let lhs, rhs;
  const args: t.Expression[] = [
    setClassName
      ? createSetFunctionNameCall(state, setClassName)
      : t.thisExpression(),
    classDecorations,
    elementDecorations,
  ];

  if (!process.env.BABEL_8_BREAKING) {
    if (version !== "2023-11") {
      args.splice(1, 2, elementDecorations, classDecorations);
    }
    if (
      version === "2021-12" ||
      (version === "2022-03" && !state.availableHelper("applyDecs2203R"))
    ) {
      lhs = t.arrayPattern([...elementLocals, ...classLocals]);
      rhs = t.callExpression(
        state.addHelper(version === "2021-12" ? "applyDecs" : "applyDecs2203"),
        args,
      );
      return t.assignmentExpression("=", lhs, rhs);
    } else if (version === "2022-03") {
      rhs = t.callExpression(state.addHelper("applyDecs2203R"), args);
    } else if (version === "2023-01") {
      if (maybePrivateBrandName) {
        args.push(createPrivateBrandCheckClosure(maybePrivateBrandName));
      }
      rhs = t.callExpression(state.addHelper("applyDecs2301"), args);
    } else if (version === "2023-05") {
      if (
        maybePrivateBrandName ||
        superClass ||
        classDecorationsFlag.value !== 0
      ) {
        args.push(classDecorationsFlag);
      }
      if (maybePrivateBrandName) {
        args.push(createPrivateBrandCheckClosure(maybePrivateBrandName));
      } else if (superClass) {
        args.push(t.unaryExpression("void", t.numericLiteral(0)));
      }
      if (superClass) args.push(superClass);
      rhs = t.callExpression(state.addHelper("applyDecs2305"), args);
    }
  }
  if (process.env.BABEL_8_BREAKING || version === "2023-11") {
    if (
      maybePrivateBrandName ||
      superClass ||
      classDecorationsFlag.value !== 0
    ) {
      args.push(classDecorationsFlag);
    }
    if (maybePrivateBrandName) {
      args.push(createPrivateBrandCheckClosure(maybePrivateBrandName));
    } else if (superClass) {
      args.push(t.unaryExpression("void", t.numericLiteral(0)));
    }
    if (superClass) args.push(superClass);
    rhs = t.callExpression(state.addHelper("applyDecs2311"), args);
  }

  // optimize `{ c: [classLocals] } = applyDecsHelper(...)` to
  // `[classLocals] = applyDecsHelper(...).c`
  if (elementLocals.length > 0) {
    if (classLocals.length > 0) {
      lhs = t.objectPattern([
        t.objectProperty(t.identifier("e"), t.arrayPattern(elementLocals)),
        t.objectProperty(t.identifier("c"), t.arrayPattern(classLocals)),
      ]);
    } else {
      lhs = t.arrayPattern(elementLocals);
      rhs = t.memberExpression(rhs, t.identifier("e"), false, false);
    }
  } else {
    // invariant: classLocals.length > 0
    lhs = t.arrayPattern(classLocals);
    rhs = t.memberExpression(rhs, t.identifier("c"), false, false);
  }

  return t.assignmentExpression("=", lhs, rhs);
}

function isProtoKey(
  node: t.Identifier | t.StringLiteral | t.BigIntLiteral | t.NumericLiteral,
) {
  return node.type === "Identifier"
    ? node.name === "__proto__"
    : node.value === "__proto__";
}

function isDecorated(node: t.Class | ClassDecoratableElement) {
  return node.decorators && node.decorators.length > 0;
}

function shouldTransformElement(node: ClassElement) {
  switch (node.type) {
    case "ClassAccessorProperty":
      return true;
    case "ClassMethod":
    case "ClassProperty":
    case "ClassPrivateMethod":
    case "ClassPrivateProperty":
      return isDecorated(node);
    default:
      return false;
  }
}

function shouldTransformClass(node: t.Class) {
  return isDecorated(node) || node.body.body.some(shouldTransformElement);
}

// Todo: unify name references logic with helper-function-name
function NamedEvaluationVisitoryFactory(
  isAnonymous: (path: NodePath) => boolean,
  visitor: (
    path: NodePath,
    state: PluginPass,
    name:
      | string
      | t.Identifier
      | t.StringLiteral
      | t.NumericLiteral
      | t.BigIntLiteral,
  ) => void,
) {
  function handleComputedProperty(
    propertyPath: NodePath<
      t.ObjectProperty | t.ClassProperty | t.ClassAccessorProperty
    >,
    key: t.Expression,
    state: PluginPass,
  ): t.StringLiteral | t.Identifier {
    switch (key.type) {
      case "StringLiteral":
        return t.stringLiteral(key.value);
      case "NumericLiteral":
      case "BigIntLiteral": {
        const keyValue = key.value + "";
        propertyPath.get("key").replaceWith(t.stringLiteral(keyValue));
        return t.stringLiteral(keyValue);
      }
      default: {
        const ref = propertyPath.scope.maybeGenerateMemoised(key);
        propertyPath
          .get("key")
          .replaceWith(
            t.assignmentExpression(
              "=",
              ref,
              createToPropertyKeyCall(state, key),
            ),
          );
        return t.cloneNode(ref);
      }
    }
  }
  return {
    VariableDeclarator(path, state) {
      const id = path.node.id;
      if (id.type === "Identifier") {
        const initializer = skipTransparentExprWrappers(path.get("init"));
        if (isAnonymous(initializer)) {
          const name = id.name;
          visitor(initializer, state, name);
        }
      }
    },
    AssignmentExpression(path, state) {
      const id = path.node.left;
      if (id.type === "Identifier") {
        const initializer = skipTransparentExprWrappers(path.get("right"));
        if (isAnonymous(initializer)) {
          switch (path.node.operator) {
            case "=":
            case "&&=":
            case "||=":
            case "??=":
              visitor(initializer, state, id.name);
          }
        }
      }
    },
    AssignmentPattern(path, state) {
      const id = path.node.left;
      if (id.type === "Identifier") {
        const initializer = skipTransparentExprWrappers(path.get("right"));
        if (isAnonymous(initializer)) {
          const name = id.name;
          visitor(initializer, state, name);
        }
      }
    },
    // We listen on ObjectExpression so that we don't have to visit
    // the object properties under object patterns
    ObjectExpression(path, state) {
      for (const propertyPath of path.get("properties")) {
        const { node } = propertyPath;
        if (node.type !== "ObjectProperty") continue;
        const id = node.key;
        const initializer = skipTransparentExprWrappers(
          propertyPath.get("value"),
        );
        if (isAnonymous(initializer)) {
          if (!node.computed) {
            // 13.2.5.5 RS: PropertyDefinitionEvaluation
            if (!isProtoKey(id as t.StringLiteral | t.Identifier)) {
              if (id.type === "Identifier") {
                visitor(initializer, state, id.name);
              } else {
                const className = t.stringLiteral(
                  (id as t.StringLiteral | t.NumericLiteral | t.BigIntLiteral)
                    .value + "",
                );
                visitor(initializer, state, className);
              }
            }
          } else {
            const ref = handleComputedProperty(
              propertyPath as NodePath<t.ObjectProperty>,
              // The key of a computed object property must not be a private name
              id as t.Expression,
              state,
            );
            visitor(initializer, state, ref);
          }
        }
      }
    },
    ClassPrivateProperty(path, state) {
      const { node } = path;
      const initializer = skipTransparentExprWrappers(path.get("value"));
      if (isAnonymous(initializer)) {
        const className = t.stringLiteral("#" + node.key.id.name);
        visitor(initializer, state, className);
      }
    },
    ClassAccessorProperty(path, state) {
      const { node } = path;
      const id = node.key;
      const initializer = skipTransparentExprWrappers(path.get("value"));
      if (isAnonymous(initializer)) {
        if (!node.computed) {
          if (id.type === "Identifier") {
            visitor(initializer, state, id.name);
          } else if (id.type === "PrivateName") {
            const className = t.stringLiteral("#" + id.id.name);
            visitor(initializer, state, className);
          } else {
            const className = t.stringLiteral(
              (id as t.StringLiteral | t.NumericLiteral | t.BigIntLiteral)
                .value + "",
            );
            visitor(initializer, state, className);
          }
        } else {
          const ref = handleComputedProperty(
            path,
            // The key of a computed accessor property must not be a private name
            id as t.Expression,
            state,
          );
          visitor(initializer, state, ref);
        }
      }
    },
    ClassProperty(path, state) {
      const { node } = path;
      const id = node.key;
      const initializer = skipTransparentExprWrappers(path.get("value"));
      if (isAnonymous(initializer)) {
        if (!node.computed) {
          if (id.type === "Identifier") {
            visitor(initializer, state, id.name);
          } else {
            const className = t.stringLiteral(
              (id as t.StringLiteral | t.NumericLiteral | t.BigIntLiteral)
                .value + "",
            );
            visitor(initializer, state, className);
          }
        } else {
          const ref = handleComputedProperty(path, id, state);
          visitor(initializer, state, ref);
        }
      }
    },
  } satisfies Visitor<PluginPass>;
}

function isDecoratedAnonymousClassExpression(path: NodePath) {
  return (
    path.isClassExpression({ id: null }) && shouldTransformClass(path.node)
  );
}

function generateLetUidIdentifier(scope: Scope, name: string) {
  const id = scope.generateUidIdentifier(name);
  scope.push({ id, kind: "let" });
  return t.cloneNode(id);
}

export default function (
  { assertVersion, assumption }: PluginAPI,
  { loose }: Options,
  version: DecoratorVersionKind,
  inherits: PluginObject["inherits"],
): PluginObject {
  if (process.env.BABEL_8_BREAKING) {
    assertVersion(REQUIRED_VERSION("^7.21.0"));
  } else {
    if (
      version === "2023-11" ||
      version === "2023-05" ||
      version === "2023-01"
    ) {
      assertVersion(REQUIRED_VERSION("^7.21.0"));
    } else if (version === "2021-12") {
      assertVersion(REQUIRED_VERSION("^7.16.0"));
    } else {
      assertVersion(REQUIRED_VERSION("^7.19.0"));
    }
  }

  const VISITED = new WeakSet<NodePath>();
  const constantSuper = assumption("constantSuper") ?? loose;
  const ignoreFunctionLength = assumption("ignoreFunctionLength") ?? loose;

  const namedEvaluationVisitor: Visitor<PluginPass> =
    NamedEvaluationVisitoryFactory(
      isDecoratedAnonymousClassExpression,
      visitClass,
    );

  function visitClass(
    path: NodePath<t.Class>,
    state: PluginPass,
    className: string | t.Identifier | t.StringLiteral | undefined,
  ) {
    if (VISITED.has(path)) return;
    const { node } = path;
    className ??= node.id?.name;
    const newPath = transformClass(
      path,
      state,
      constantSuper,
      ignoreFunctionLength,
      className,
      namedEvaluationVisitor,
      version,
    );
    if (newPath) {
      VISITED.add(newPath);
      return;
    }
    VISITED.add(path);
  }

  return {
    name: "proposal-decorators",
    inherits: inherits,

    visitor: {
      ExportDefaultDeclaration(path, state) {
        const { declaration } = path.node;
        if (
          declaration?.type === "ClassDeclaration" &&
          // When compiling class decorators we need to replace the class
          // binding, so we must split it in two separate declarations.
          isDecorated(declaration)
        ) {
          const isAnonymous = !declaration.id;
          const updatedVarDeclarationPath = splitExportDeclaration(
            path,
          ) as unknown as NodePath<t.ClassDeclaration>;
          if (isAnonymous) {
            visitClass(
              updatedVarDeclarationPath,
              state,
              t.stringLiteral("default"),
            );
          }
        }
      },
      ExportNamedDeclaration(path) {
        const { declaration } = path.node;
        if (
          declaration?.type === "ClassDeclaration" &&
          // When compiling class decorators we need to replace the class
          // binding, so we must split it in two separate declarations.
          isDecorated(declaration)
        ) {
          splitExportDeclaration(path);
        }
      },

      Class(path, state) {
        visitClass(path, state, undefined);
      },

      ...namedEvaluationVisitor,
    },
  };
}
