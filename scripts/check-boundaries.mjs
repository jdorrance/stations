import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { packages, filesIn, buildOrder, root } from './workspace.mjs';

const allowed = {
  geography: [],
  contracts: ['geography'],
  providers: ['geography', 'contracts'],
  client: ['geography', 'contracts'],
};
const server = new Set(['providers']);
const errors = [];

function moduleImports(path) {
  const raw = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
  const toolkit = path.startsWith(resolve(root, 'packages') + sep);
  if (toolkit && /@ts-(?:nocheck|ignore)\b/.test(raw)) errors.push(`${relative(root, path)}: suppresses type checking`);
  const imports = [];
  const walk = node => {
    if (toolkit && node.kind === ts.SyntaxKind.AnyKeyword) errors.push(`${relative(root, path)}: use a checked type or unknown instead of any`);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports.push(node.argument.literal.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return imports;
}

function checkPublicEntry(specifier, label) {
  const dependency = specifier.split('/').slice(0, 2).join('/');
  const local = packages.find(pkg => pkg.manifest.name === dependency);
  if (!local) return;
  const subpath = specifier === dependency ? '.' : `.${specifier.slice(dependency.length)}`;
  if (!Object.hasOwn(local.manifest.exports ?? {}, subpath)) errors.push(`${label}: private package entry ${specifier}`);
}

buildOrder();
for (const { manifest, directory } of packages) {
  const name = manifest.name.replace('@stations/', '');
  const config = ts.readConfigFile(resolve(directory, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  if (!options.strict || options.noImplicitAny === false || options.allowJs) errors.push(`${manifest.name}: packages require strict TypeScript`);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@stations/') && !allowed[name]?.includes(dependency.replace('@stations/', ''))) {
      errors.push(`${manifest.name}: forbidden dependency ${dependency}`);
    }
  }
  for (const path of filesIn(resolve(directory, 'src')).filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
    if (/\.[cm]?jsx?$/.test(path)) errors.push(`${relative(root, path)}: toolkit implementation must be TypeScript`);
    for (const specifier of moduleImports(path)) {
      const label = `${relative(directory, path)}: ${specifier}`;
      if (specifier.startsWith('.')) {
        const target = resolve(path, '..', specifier);
        if (!target.startsWith(resolve(directory, 'src') + sep)) errors.push(`${manifest.name} imports outside its source tree (${label})`);
        continue;
      }
      if (specifier.startsWith('node:')) {
        if (!server.has(name)) errors.push(`${manifest.name} has a server dependency (${label})`);
        continue;
      }
      const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!(dependency in (manifest.dependencies ?? {}))) errors.push(`${manifest.name} has an undeclared dependency (${label})`);
      checkPublicEntry(specifier, `${manifest.name} (${label})`);
    }
  }
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`Package boundaries passed (${packages.length} packages).`);
