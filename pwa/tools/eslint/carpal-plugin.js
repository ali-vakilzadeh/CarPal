// Local ESLint rules for the PWA (P1.T3).
//   carpal/logical-properties  no left/right in class names (Tailwind) or inline styles: use start/end
//                              (ms-/me-/ps-/pe-/start-/end-/text-start …), so layouts mirror in RTL.
//   carpal/no-raw-design-values  no raw colours or pixel sizes in class names or inline styles: take every value
//                              from the design-system tokens (Docs/carpal-design-system/CLAUDE.md).
// Class names are checked in className/class attributes and in the arguments of cx/clsx/cn/classNames.

const CLASS_HELPERS = new Set(['cx', 'clsx', 'cn', 'classNames']);

const PHYSICAL_CLASS =
  /^-?(?:m[lr]|p[lr]|scroll-m[lr]|scroll-p[lr]|left|right|border-[lr]|rounded-(?:[lr]|tl|tr|bl|br)|space-x-reverse|divide-x-reverse)(?:-|$)/;
const PHYSICAL_CLASS_EXACT = new Set(['text-left', 'text-right', 'float-left', 'float-right', 'clear-left', 'clear-right']);

const PHYSICAL_STYLE_KEYS = new Set([
  'left',
  'right',
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'borderLeft',
  'borderRight',
  'borderLeftWidth',
  'borderRightWidth',
  'borderLeftColor',
  'borderRightColor',
  'borderLeftStyle',
  'borderRightStyle',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'scrollMarginLeft',
  'scrollMarginRight',
  'scrollPaddingLeft',
  'scrollPaddingRight',
]);
const DIRECTIONAL_VALUE_KEYS = new Set(['textAlign', 'float', 'clear']);

const RAW_VALUE = /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em)\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;

/** Splits a class string into utilities without variants (md:, hover:, rtl:) and the important mark. */
export function classTokens(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) =>
      token
        .slice(token.lastIndexOf(':') + 1)
        .replace(/^!/, '')
        .replace(/!$/, ''),
    );
}

export function isPhysicalClass(utility) {
  return PHYSICAL_CLASS_EXACT.has(utility) || PHYSICAL_CLASS.test(utility);
}

export function hasRawValue(utility) {
  const arbitrary = utility.match(/\[([^\]]*)\]/);
  return arbitrary !== null && RAW_VALUE.test(arbitrary[1] ?? '');
}

/** String pieces (literals and template parts) inside a class-name expression. */
function stringParts(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value });
      break;
    case 'TemplateLiteral':
      for (const q of node.quasis) out.push({ node: q, text: q.value.cooked ?? q.value.raw });
      for (const e of node.expressions) stringParts(e, out);
      break;
    case 'JSXExpressionContainer':
      stringParts(node.expression, out);
      break;
    case 'ConditionalExpression':
      stringParts(node.consequent, out);
      stringParts(node.alternate, out);
      break;
    case 'LogicalExpression':
      stringParts(node.left, out);
      stringParts(node.right, out);
      break;
    case 'BinaryExpression':
      stringParts(node.left, out);
      stringParts(node.right, out);
      break;
    case 'ArrayExpression':
      for (const e of node.elements) stringParts(e, out);
      break;
    case 'ObjectExpression':
      for (const p of node.properties) if (p.type === 'Property') stringParts(p.key, out);
      break;
    case 'CallExpression':
      if (node.callee.type === 'Identifier' && CLASS_HELPERS.has(node.callee.name)) for (const a of node.arguments) stringParts(a, out);
      break;
    default:
      break;
  }
  return out;
}

function classVisitors(context, check) {
  const report = (parts) => {
    for (const { node, text } of parts) for (const utility of classTokens(text)) check(node, utility);
  };
  return {
    JSXAttribute(node) {
      if (node.name.type === 'JSXIdentifier' && (node.name.name === 'className' || node.name.name === 'class'))
        report(stringParts(node.value));
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && CLASS_HELPERS.has(node.callee.name)) {
        // Only top-level helper calls; nested ones are reached through stringParts of the attribute.
        if (node.parent?.type === 'JSXExpressionContainer' || node.parent?.type === 'CallExpression') return;
        report(node.arguments.flatMap((a) => stringParts(a)));
      }
    },
  };
}

function styleProperties(node) {
  if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'style') return [];
  const expr = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : null;
  return expr?.type === 'ObjectExpression' ? expr.properties.filter((p) => p.type === 'Property') : [];
}

function keyName(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') return String(property.key.value);
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const logicalProperties = {
  meta: {
    type: 'problem',
    docs: { description: 'Use logical (start/end) properties and utilities instead of left/right.' },
    messages: {
      physicalClass: "'{{utility}}' is a left/right utility; use the logical one (ms-/me-/ps-/pe-/start-/end-/text-start/text-end …).",
      physicalStyle: "'{{key}}' is a left/right style; use the logical property (marginInlineStart, insetInlineEnd …).",
      physicalValue: "'{{key}}: {{value}}' is direction-bound; use 'start' or 'end'.",
    },
    schema: [],
  },
  create(context) {
    const classes = classVisitors(context, (node, utility) => {
      if (isPhysicalClass(utility)) context.report({ node, messageId: 'physicalClass', data: { utility } });
    });
    return {
      ...classes,
      JSXAttribute(node) {
        classes.JSXAttribute(node);
        for (const p of styleProperties(node)) {
          const key = keyName(p);
          if (key && PHYSICAL_STYLE_KEYS.has(key)) context.report({ node: p, messageId: 'physicalStyle', data: { key } });
          if (
            key &&
            DIRECTIONAL_VALUE_KEYS.has(key) &&
            p.value.type === 'Literal' &&
            (p.value.value === 'left' || p.value.value === 'right')
          ) {
            context.report({ node: p, messageId: 'physicalValue', data: { key, value: p.value.value } });
          }
        }
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noRawDesignValues = {
  meta: {
    type: 'problem',
    docs: { description: 'Take colours and sizes from the design-system tokens, never raw values.' },
    messages: {
      rawClass: "'{{utility}}' uses a raw value; use a token utility or var(--token).",
      rawStyle: "'{{key}}' uses a raw value; use var(--token).",
    },
    schema: [],
  },
  create(context) {
    const classes = classVisitors(context, (node, utility) => {
      if (hasRawValue(utility)) context.report({ node, messageId: 'rawClass', data: { utility } });
    });
    return {
      ...classes,
      JSXAttribute(node) {
        classes.JSXAttribute(node);
        for (const p of styleProperties(node)) {
          if (p.value.type === 'Literal' && typeof p.value.value === 'string' && RAW_VALUE.test(p.value.value)) {
            context.report({ node: p, messageId: 'rawStyle', data: { key: keyName(p) ?? '?' } });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'carpal' },
  rules: { 'logical-properties': logicalProperties, 'no-raw-design-values': noRawDesignValues },
};
