import spec from 'honestui/genui/chat-spec.json' with { type: 'json' };

// HtmlVisual runs model-written scripts in a srcdoc frame. A srcdoc frame inherits
// the renderer's CSP, and packaged builds allow no inline scripts, so the visual
// would not run. Leave it out until it can be served from an isolated origin.
export const excludedComponentNames = ['HtmlVisual'];

const excluded = new Set(excludedComponentNames);
const mentionsExcluded = text => excludedComponentNames.some(name => new RegExp(`\\b${name}\\b`).test(text));
const withoutUnionMembers = signature => excludedComponentNames.reduce(
  (text, name) => text.replace(new RegExp(`\\s*\\|\\s*${name}\\b|\\b${name}\\s*\\|\\s*`, 'g'), ''),
  signature,
);
const isExcludedRef = schema => excludedComponentNames.some(name => schema?.$ref === `#/$defs/${name}`);

function withoutExcludedSchema(schema) {
  if (Array.isArray(schema)) return schema.filter(item => !isExcludedRef(item)).map(withoutExcludedSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === 'properties' || key === '$defs') {
      return [key, Object.fromEntries(Object.entries(value).filter(([name]) => !excluded.has(name)).map(([name, child]) => [name, withoutExcludedSchema(child)]))];
    }
    if (key === 'required' && Array.isArray(value)) return [key, value.filter(name => !excluded.has(name))];
    return [key, withoutExcludedSchema(value)];
  }));
}

/** The upstream chat spec without components the desktop renderer cannot run. */
export const desktopChatSpec = {
  ...spec,
  components: Object.fromEntries(Object.entries(spec.components)
    .filter(([name]) => !excluded.has(name))
    .map(([name, component]) => [name, { ...component, signature: withoutUnionMembers(component.signature) }])),
  componentGroups: spec.componentGroups.map(group => ({
    ...group,
    components: group.components.filter(name => !excluded.has(name)),
    ...(group.notes && { notes: group.notes.filter(note => !mentionsExcluded(note)) }),
  })).filter(group => group.components.length),
  schema: withoutExcludedSchema(spec.schema),
  preamble: spec.preamble.split('\n').filter(line => !mentionsExcluded(line)).join('\n'),
  examples: spec.examples.filter(example => !mentionsExcluded(example)),
  additionalRules: spec.additionalRules.filter(rule => !mentionsExcluded(rule)),
};

export const desktopComponentNames = Object.keys(desktopChatSpec.components);
