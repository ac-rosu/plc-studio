// Webviews: LAD/FBD viewer and editor, interface, DB, tag table and translation tables,
// program graph. Each view is a folder with a main.ts entry; they talk only to the extension,
// through messages (shared/messaging.ts).
export * from './shared/messaging.ts';
export * from './shared/dom.ts';
