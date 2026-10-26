import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const within = (root, path) => path.startsWith(root + sep);

/** Check public declarations emitted by TypeScript. */
export function inspectApi(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const dist = resolve(directory, 'dist');
  const entries = Object.entries(manifest.exports).filter(([, target]) => typeof target === 'object' && target.types);
  const roots = entries.map(([, target]) => resolve(directory, target.types));
  const program = ts.createProgram(roots, {
    strict: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const errors = ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${relative(dist, diagnostic.file.fileName).replaceAll('\\', '/')}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : manifest.name;
    return `${location}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  const visited = new Set();
  const sourceKey = source => relative(dist, source.fileName).replaceAll('\\', '/');
  const unalias = symbol => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const visitSymbol = symbol => {
    for (const declaration of unalias(symbol)?.declarations ?? []) visitDeclaration(declaration);
  };
  const visitDeclaration = declaration => {
    const source = declaration.getSourceFile();
    if (!within(dist, source.fileName)) return;
    let top = declaration;
    while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
    if (ts.isImportDeclaration(top) || ts.isExportDeclaration(top) || visited.has(top)) return;
    visited.add(top);
    const key = sourceKey(source);
    const walk = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) errors.push(`${key}: public declaration exposes any`);
      if (ts.isIdentifier(node)) visitSymbol(checker.getSymbolAtLocation(node));
      if (ts.isImportTypeNode(node) && !node.qualifier) {
        for (const member of checker.getPropertiesOfType(checker.getTypeAtLocation(node))) visitSymbol(member);
      }
      ts.forEachChild(node, walk);
    };
    walk(top);
  };

  const exported = {};
  for (const [entry, target] of entries) {
    if (entry.includes('*')) errors.push(`${entry}: wildcard export path`);
    const source = program.getSourceFile(resolve(directory, target.types));
    if (!source) { errors.push(`${entry}: missing declaration file`); continue; }
    for (const node of source.statements) {
      if (ts.isExportDeclaration(node) && !node.exportClause) errors.push(`${entry}: wildcard barrel export`);
    }
    const module = checker.getSymbolAtLocation(source);
    if (!module) { errors.push(`${entry}: declaration file is not a module`); continue; }
    const symbols = checker.getExportsOfModule(module).sort((a, b) => a.name.localeCompare(b.name));
    exported[entry] = symbols.map(symbol => {
      const actual = unalias(symbol);
      visitSymbol(actual);
      return { name: symbol.name, kind: actual.flags & ts.SymbolFlags.Value ? 'value' : 'type' };
    });
  }
  for (const [entry, target] of Object.entries(manifest.exports)) {
    if (entry.includes('*')) errors.push(`${entry}: wildcard export path`);
    for (const path of typeof target === 'string' ? [target] : Object.values(target)) {
      if (!existsSync(resolve(directory, path))) errors.push(`${entry}: missing emitted export ${path}`);
    }
  }
  return { entries: exported, errors: [...new Set(errors)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { packages } = await import('./workspace.mjs');
  let failed = false;
  for (const { directory, manifest } of packages) {
    const { entries, errors } = inspectApi(directory);
    if (errors.length) { failed = true; console.error(`${manifest.name}:\n${errors.join('\n')}`); continue; }
    const count = Object.values(entries).reduce((sum, entries) => sum + entries.length, 0);
    console.log(`${manifest.name}: ${Object.keys(entries).length} entries, ${count} exported names`);
  }
  if (failed) process.exitCode = 1;
}
