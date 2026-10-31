import spec from 'honestui/genui/chat-spec.json' with { type: 'json' };

// The renderer and generated model instructions share the complete upstream catalog.
export const desktopComponentNames = Object.keys(spec.components);
