// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file swizzle.copy module graph — decides, for each module a component
 * reaches, whether the copy imports it from the owner package's public
 * exports or carries it in the output.
 *
 * @input the owner package's source root and `exports` map, the component folder
 * @output the files the copy holds, each with its rewritten source
 * @position api/swizzle adapter helper; the copy leaf reaches it through _adapter.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {parse} from '@babel/parser';

/** The extensions an extensionless import may name, in resolution order. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];
const INDEX_FILES = SOURCE_EXTENSIONS.map(ext => `/index${ext}`);
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const STYLEX_FILE = /\.stylex\.[cm]?[jt]sx?$/;

/** @param {string} file */
const toPosix = file => file.split(path.sep).join('/');

/**
 * The file an import names, or null when no file is there.
 * @param {string} fromFile absolute path of the importing file
 * @param {string} specifier a relative specifier
 * @returns {string|null}
 */
export function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const cached = resolveCache.get(base);
  if (cached !== undefined) return cached;
  const found = resolveUncached(base);
  resolveCache.set(base, found);
  return found;
}

/** @type {Map<string, string|null>} */
const resolveCache = new Map();

/** @param {string} base */
function resolveUncached(base) {
  for (const suffix of ['', ...SOURCE_EXTENSIONS, ...INDEX_FILES]) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * @typedef {object} ImportSpecifier
 * @property {string} imported the exported name (`default` for a default import)
 * @property {string} local
 * @property {boolean} typeOnly
 *
 * @typedef {object} ModuleReference
 * @property {'named'|'namespace'|'sideEffect'|'dynamic'|'reexportAll'|'reexportNamed'} kind
 * @property {string} source the specifier as written
 * @property {number} start statement (or, for `import()`, string literal) start
 * @property {number} end
 * @property {boolean} typeOnly the whole statement is `import type` / `export type`
 * @property {ImportSpecifier[]} specifiers
 * @property {string} [namespace] the local name of `* as X`
 *
 * @typedef {object} ParsedModule
 * @property {string} code
 * @property {ModuleReference[]} references
 *
 * @typedef {Map<string, {source: string|null, name: string}>} ExportEntries
 *   exported name -> where it comes from (`source` null for a declaration in
 *   the module itself)
 */

/** @type {Map<string, ParsedModule>} */
const parseCache = new Map();

/**
 * A module's source and every module reference in it: static imports and
 * re-exports, `import()` calls, and `import('…')` types.
 * @param {string} file
 * @returns {ParsedModule}
 */
export function parseModule(file) {
  const cached = parseCache.get(file);
  if (cached) return cached;
  const code = fs.readFileSync(file, 'utf-8');
  /** @type {ParsedModule} */
  const parsed = {code, references: []};
  parseCache.set(file, parsed);
  if (!CODE_FILE.test(file)) return parsed;
  const ast = parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    plugins: /\.[cm]?tsx?$/.test(file) ? ['typescript', 'jsx'] : ['jsx'],
  });
  const {references} = parsed;
  // Babel's node types mark positions optional; a parsed file always has them.
  for (const node of /** @type {any[]} */ (ast.program.body)) {
    if (node.type === 'ImportDeclaration') {
      const typeOnly = node.importKind === 'type';
      const base = {
        source: node.source.value,
        start: node.start,
        end: node.end,
        typeOnly,
      };
      const namespace = node.specifiers.find(
        (/** @type {any} */ s) => s.type === 'ImportNamespaceSpecifier',
      );
      const named = node.specifiers.filter(
        (/** @type {any} */ s) => s.type !== 'ImportNamespaceSpecifier',
      );
      if (node.specifiers.length === 0) {
        references.push({...base, kind: 'sideEffect', specifiers: []});
      } else if (namespace && named.length === 0) {
        references.push({
          ...base,
          kind: 'namespace',
          specifiers: [],
          namespace: namespace.local.name,
        });
      } else if (!namespace) {
        references.push({
          ...base,
          kind: 'named',
          specifiers: named.map((/** @type {any} */ s) => ({
            imported:
              s.type === 'ImportDefaultSpecifier'
                ? 'default'
                : s.imported.type === 'StringLiteral'
                  ? s.imported.value
                  : s.imported.name,
            local: s.local.name,
            typeOnly: typeOnly || s.importKind === 'type',
          })),
        });
      } else {
        // `import X, * as Y from` names the whole module.
        references.push({...base, kind: 'namespace', specifiers: []});
      }
    } else if (node.type === 'ExportAllDeclaration') {
      references.push({
        kind: 'reexportAll',
        source: node.source.value,
        start: node.start,
        end: node.end,
        typeOnly: node.exportKind === 'type',
        specifiers: [],
      });
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      const typeOnly = node.exportKind === 'type';
      references.push({
        kind: 'reexportNamed',
        source: node.source.value,
        start: node.start,
        end: node.end,
        typeOnly,
        specifiers: node.specifiers.map((/** @type {any} */ s) => ({
          imported: s.type === 'ExportNamespaceSpecifier' ? '*' : s.local.name,
          local:
            s.exported.type === 'StringLiteral'
              ? s.exported.value
              : s.exported.name,
          typeOnly: typeOnly || s.exportKind === 'type',
        })),
      });
    }
  }
  visitDynamicReferences(ast.program, literal => {
    references.push({
      kind: 'dynamic',
      source: literal.value,
      start: literal.start,
      end: literal.end,
      typeOnly: false,
      specifiers: [],
    });
  });
  return parsed;
}

/**
 * Call `onLiteral` with the string literal of every `import('…')` call and
 * `import('…')` type under a node.
 * @param {any} node
 * @param {(literal: {value: string, start: number, end: number}) => void} onLiteral
 */
function visitDynamicReferences(node, onLiteral) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitDynamicReferences(child, onLiteral);
    return;
  }
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'Import' &&
    node.arguments[0]?.type === 'StringLiteral'
  ) {
    onLiteral(node.arguments[0]);
  } else if (
    node.type === 'ImportExpression' &&
    node.source?.type === 'StringLiteral'
  ) {
    onLiteral(node.source);
  } else if (node.type === 'TSImportType') {
    const literal =
      node.argument?.type === 'TSLiteralType'
        ? node.argument.literal
        : node.argument;
    if (literal?.type === 'StringLiteral') onLiteral(literal);
  }
  for (const key of Object.keys(node)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments'
    )
      continue;
    const value = node[key];
    if (value && typeof value === 'object')
      visitDynamicReferences(value, onLiteral);
  }
}

/** @type {Map<string, {exports: ExportEntries, starSources: string[]}>} */
const exportCache = new Map();

/**
 * A module's exports, read from its `export` statements without a full
 * parse: the public surface spans most of the package, and only its export
 * statements matter.
 * @param {string} file
 * @returns {{exports: ExportEntries, starSources: string[]}}
 */
export function scanExports(file) {
  const cached = exportCache.get(file);
  if (cached) return cached;
  /** @type {ExportEntries} */
  const exports = new Map();
  /** @type {string[]} */
  const starSources = [];
  const result = {exports, starSources};
  exportCache.set(file, result);
  if (!CODE_FILE.test(file)) return result;
  const code = fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(
    /^export\s+(?:type\s+)?\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/gm,
  )) {
    if (m[1]) exports.set(m[1], {source: m[2], name: '*'});
    else starSources.push(m[2]);
  }
  for (const m of code.matchAll(
    /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s+['"]([^'"]+)['"])?/gm,
  )) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const [local, exported = local] = part
        .split(/\s+as\s+/)
        .map(x => x.trim());
      exports.set(exported, {source: m[2] ?? null, name: local});
    }
  }
  for (const m of code.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    exports.set(m[1], {source: null, name: m[1]});
  }
  for (const m of code.matchAll(
    /^export\s+(?:const|let|var)\s+\{([^}]*)\}/gm,
  )) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop()?.trim().replace(/=.*$/, '').trim();
      if (name) exports.set(name, {source: null, name});
    }
  }
  if (/^export\s+default\b/m.test(code) || /^export\s*=/m.test(code)) {
    exports.set('default', {source: null, name: 'default'});
  }
  return result;
}

/** @type {Map<string, Map<string, {file: string, name: string}>>} */
const exportMapCache = new Map();

/**
 * Every name a module exports, `export *` included, with the module that
 * defines it and its name there.
 * @param {string} file
 * @param {Set<string>} [visiting] modules on the current path, against cycles
 * @returns {Map<string, {file: string, name: string}>}
 */
export function exportMapOf(file, visiting = new Set()) {
  const cached = exportMapCache.get(file);
  if (cached) return cached;
  /** @type {Map<string, {file: string, name: string}>} */
  const map = new Map();
  if (visiting.has(file)) return map;
  visiting.add(file);
  const {exports, starSources} = scanExports(file);
  for (const [name, entry] of exports) {
    if (entry.source == null) {
      map.set(name, {file, name});
      continue;
    }
    if (!entry.source.startsWith('.')) {
      map.set(name, {file: entry.source, name: entry.name});
      continue;
    }
    const target = resolveRelative(file, entry.source);
    if (!target) continue;
    if (entry.name === '*') {
      map.set(name, {file: target, name: '*'});
      continue;
    }
    map.set(
      name,
      exportMapOf(target, visiting).get(entry.name) ?? {
        file: target,
        name: entry.name,
      },
    );
  }
  for (const source of starSources) {
    if (!source.startsWith('.')) continue;
    const target = resolveRelative(file, source);
    if (!target) continue;
    for (const [name, origin] of exportMapOf(target, visiting)) {
      if (name !== 'default' && !map.has(name)) map.set(name, origin);
    }
  }
  visiting.delete(file);
  exportMapCache.set(file, map);
  return map;
}

/**
 * Where an exported name of a module is defined.
 * @param {string} file
 * @param {string} name
 * @returns {{file: string, name: string}|null}
 */
export function originOf(file, name) {
  return exportMapOf(file).get(name) ?? null;
}

/**
 * Every name a module exports.
 * @param {string} file
 * @returns {Set<string>}
 */
export function exportedNamesOf(file) {
  return new Set(exportMapOf(file).keys());
}

/**
 * The owner package's public surface: for each subpath its `exports` map
 * lists with a source file under the source root, the names it exports and
 * where each is defined. `./internal/*` subpaths are not public.
 *
 * @param {string} packageDir
 * @param {string} srcRoot
 * @returns {{byOrigin: Map<string, Array<{subpath: string, name: string}>>, byFile: Map<string, string>, patterns: string[]}}
 */
export function publicSurfaceOf(packageDir, srcRoot) {
  /** @type {Record<string, unknown>} */
  let exportsMap;
  try {
    exportsMap =
      JSON.parse(
        fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'),
      ).exports ?? {};
  } catch {
    exportsMap = {};
  }
  /** @type {Map<string, Array<{subpath: string, name: string}>>} */
  const byOrigin = new Map();
  /** @type {Map<string, string>} source file -> its exact subpath */
  const byFile = new Map();
  /** @type {string[]} */
  const patterns = [];
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (/^\.\/internal(\/|$)/.test(subpath)) continue;
    if (subpath.includes('*')) {
      patterns.push(subpath);
      continue;
    }
    const sourceFile = sourceFileOf(packageDir, srcRoot, subpath, target);
    if (!sourceFile) continue;
    byFile.set(sourceFile, subpath);
    if (!CODE_FILE.test(sourceFile)) continue;
    for (const name of exportedNamesOf(sourceFile)) {
      const origin = originOf(sourceFile, name);
      if (!origin) continue;
      const key = `${origin.file}#${origin.name}`;
      const list = byOrigin.get(key) ?? [];
      list.push({subpath, name});
      byOrigin.set(key, list);
    }
  }
  return {byOrigin, byFile, patterns};
}

/**
 * The source file behind an `exports` entry: its `source` condition, or the
 * same path under the source root as its default target under `dist`.
 * @param {string} packageDir
 * @param {string} srcRoot
 * @param {string} subpath
 * @param {unknown} target
 * @returns {string|null}
 */
function sourceFileOf(packageDir, srcRoot, subpath, target) {
  const conditions =
    typeof target === 'string'
      ? {default: target}
      : /** @type {Record<string, unknown>} */ (target ?? {});
  const candidates = [];
  if (typeof conditions.source === 'string')
    candidates.push(path.join(packageDir, conditions.source));
  for (const value of [conditions.default, conditions.import]) {
    if (typeof value === 'string')
      candidates.push(path.join(packageDir, value));
  }
  const rest = subpath === '.' ? 'index' : subpath.slice(2);
  candidates.push(path.join(srcRoot, rest));
  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      candidate.startsWith(srcRoot + path.sep)
    ) {
      return candidate;
    }
    const stem = candidate.replace(/\.[cm]?jsx?$/, '');
    for (const suffix of ['', ...SOURCE_EXTENSIONS, ...INDEX_FILES]) {
      const file = stem + suffix;
      if (
        file.startsWith(srcRoot + path.sep) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile()
      )
        return file;
    }
  }
  return null;
}

/**
 * Whether `subpath` matches an `exports` pattern such as `./locales/*.json`.
 * @param {string[]} patterns
 * @param {string} subpath
 */
function matchesPattern(patterns, subpath) {
  return patterns.some(pattern => {
    const [head, tail] = pattern.split('*');
    return subpath.startsWith(head) && subpath.endsWith(tail);
  });
}

/**
 * A specifier that is either fixed (a public subpath) or computed from where
 * two copied files land.
 * @typedef {string | {from: string, to: string}} SpecifierChoice
 *
 * @typedef {object} PlannedEdit
 * @property {number} start
 * @property {number} end
 * @property {(specifierOf: (choice: SpecifierChoice) => string) => string} render
 *
 * @typedef {object} CopyPlan
 * @property {Map<string, {code: string, edits: PlannedEdit[]}>} files every
 *   file the copy holds (absolute source path), with the edits its imports need
 * @property {Map<string, Set<string>>} dependsOn file -> carried files its
 *   computed specifiers point at
 */

/**
 * Follow a component's module graph from its entry files and decide what the
 * copy holds. A module inside the component folder is copied. A module
 * outside it is reached through the owner package's public exports when every
 * name taken from it is public there; otherwise the module that defines the
 * name is copied, and imported by relative path. Tests, stories and docs are
 * never reached, so they are never copied.
 *
 * @param {object} options
 * @param {string} options.packageDir the owner package root
 * @param {string} options.srcRoot its source root
 * @param {string} options.componentDir
 * @param {string} options.ownerPackage
 * @param {string[]} options.entries absolute entry files of the component
 * @returns {CopyPlan}
 */
export function planCopy({
  packageDir,
  srcRoot,
  componentDir,
  ownerPackage,
  entries,
}) {
  const surface = publicSurfaceOf(packageDir, srcRoot);
  /** @type {CopyPlan['files']} */
  const files = new Map();
  /** @type {CopyPlan['dependsOn']} */
  const dependsOn = new Map();
  const queue = [...entries];
  const queued = new Set(queue);
  /** @param {string} file */
  const enqueue = file => {
    if (!queued.has(file)) {
      queued.add(file);
      queue.push(file);
    }
  };
  /** @param {string} file */
  const inComponent = file => file.startsWith(componentDir + path.sep);
  /** @param {string} file */
  const inSource = file => file.startsWith(srcRoot + path.sep);

  /**
   * The subpath that exports every name a module exports, with the same
   * definition. An exactly exported file is its own subpath.
   * @param {string} file
   * @returns {string|null}
   */
  const subpathCoveringModule = file => {
    const exact = surface.byFile.get(file);
    if (exact) return exact;
    const names = [...exportedNamesOf(file)];
    if (names.length === 0) return null;
    const options = names.map(name => {
      const origin = originOf(file, name);
      return origin
        ? (surface.byOrigin.get(`${origin.file}#${origin.name}`) ?? [])
            .filter(o => o.name === name)
            .map(o => o.subpath)
        : [];
    });
    const common = options.reduce((acc, list) =>
      acc.filter(s => list.includes(s)),
    );
    return STYLEX_FILE.test(file) ? null : pickSubpath(common, file);
  };

  /**
   * The public subpath to take a name from. A StyleX module is imported by
   * its own exported path, because the StyleX compiler resolves styles and
   * variables from the real module; when that path is not exported, there is
   * no public import.
   * @param {string[]} subpaths subpaths that export the name
   * @param {string} target the module the import names
   * @param {string} [originFile] the module that defines the name
   * @returns {string|null}
   */
  const choosePublic = (subpaths, target, originFile) => {
    const exact = originFile ? surface.byFile.get(originFile) : undefined;
    if (exact && subpaths.includes(exact)) return exact;
    if (
      STYLEX_FILE.test(target) ||
      (originFile && STYLEX_FILE.test(originFile))
    )
      return null;
    return pickSubpath(subpaths, target);
  };

  /**
   * Prefer the subpath of the module's top folder, then the package root.
   * @param {string[]} subpaths
   * @param {string} file
   * @returns {string|null}
   */
  const pickSubpath = (subpaths, file) => {
    if (subpaths.length === 0) return null;
    const top = `./${toPosix(path.relative(srcRoot, file)).split('/')[0]}`;
    return (
      subpaths.find(s => s === top) ??
      subpaths.find(s => s === '.') ??
      [...subpaths].sort((a, b) => a.length - b.length)[0]
    );
  };

  /** @param {string} subpath */
  const publicSpecifier = subpath =>
    subpath === '.' ? ownerPackage : `${ownerPackage}/${subpath.slice(2)}`;

  /**
   * Carry a module in the copy.
   * @param {string} from
   * @param {string} to
   * @returns {SpecifierChoice}
   */
  const carry = (from, to) => {
    enqueue(to);
    const deps = dependsOn.get(from) ?? new Set();
    deps.add(to);
    dependsOn.set(from, deps);
    return {from, to};
  };

  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    const parsed = parseModule(file);
    /** @type {PlannedEdit[]} */
    const edits = [];
    files.set(file, {code: parsed.code, edits});
    if (!CODE_FILE.test(file)) continue;
    for (const ref of parsed.references) {
      if (!ref.source.startsWith('.')) continue;
      const target = resolveRelative(file, ref.source);
      // A dangling import is left for the build to report.
      if (!target) continue;
      if (inComponent(target)) {
        // Files of the component keep their relative imports of each other.
        if (inComponent(file)) enqueue(target);
        else edits.push(sourceEdit(parsed.code, ref, carry(file, target)));
        continue;
      }
      if (!inSource(target)) {
        // An asset beside the source root, such as `../../locales/en.json`.
        const subpath = `./${toPosix(path.relative(packageDir, target))}`;
        if (
          matchesPattern(surface.patterns, subpath) ||
          surface.byFile.has(target)
        ) {
          edits.push(
            sourceEdit(parsed.code, ref, `${ownerPackage}/${subpath.slice(2)}`),
          );
        }
        continue;
      }
      edits.push(planReference(file, parsed.code, ref, target));
    }
  }
  return {files, dependsOn};

  /**
   * Decide one reference that leaves the component folder.
   * @param {string} file
   * @param {string} code
   * @param {ModuleReference} ref
   * @param {string} target
   * @returns {PlannedEdit}
   */
  function planReference(file, code, ref, target) {
    if (ref.kind !== 'named' && ref.kind !== 'reexportNamed') {
      const covering = subpathCoveringModule(target);
      return sourceEdit(
        code,
        ref,
        covering ? publicSpecifier(covering) : carry(file, target),
      );
    }
    /** @type {Array<{choice: SpecifierChoice, specs: ImportSpecifier[]}>} */
    const groups = [];
    /** @param {SpecifierChoice} choice @param {ImportSpecifier} spec */
    const add = (choice, spec) => {
      const same = groups.find(g =>
        typeof choice === 'string'
          ? g.choice === choice
          : typeof g.choice !== 'string' && g.choice.to === choice.to,
      );
      if (same) same.specs.push(spec);
      else groups.push({choice, specs: [spec]});
    };
    for (const spec of ref.specifiers) {
      if (spec.imported === '*') {
        const covering = subpathCoveringModule(target);
        add(covering ? publicSpecifier(covering) : carry(file, target), spec);
        continue;
      }
      const origin = originOf(target, spec.imported);
      const publicOptions = origin
        ? (surface.byOrigin.get(`${origin.file}#${origin.name}`) ?? [])
        : [];
      const chosen = choosePublic(
        publicOptions.map(o => o.subpath),
        target,
        origin?.file,
      );
      if (chosen) {
        const exported = /** @type {{name: string}} */ (
          publicOptions.find(o => o.subpath === chosen)
        ).name;
        add(publicSpecifier(chosen), {...spec, imported: exported});
      } else if (origin && !path.isAbsolute(origin.file)) {
        // A name the package re-exports from an npm package comes from there.
        add(origin.file, {...spec, imported: origin.name});
      } else if (origin && inSource(origin.file) && origin.name !== '*') {
        // Take the name from the module that defines it, so the copy carries
        // that module and not a whole barrel.
        add(carry(file, origin.file), {...spec, imported: origin.name});
      } else {
        add(carry(file, target), spec);
      }
    }
    // One source and the same names: keep the statement as written and swap
    // only its specifier.
    const unchangedNames =
      groups.length === 1 &&
      groups[0].specs.every(
        (spec, i) => spec.imported === ref.specifiers[i].imported,
      );
    if (unchangedNames) return sourceEdit(code, ref, groups[0].choice);
    return {
      start: ref.start,
      end: ref.end,
      render: specifierOf => renderStatements(ref, groups, specifierOf),
    };
  }
}

/**
 * An edit that replaces only the string literal of a reference.
 * @param {string} code
 * @param {ModuleReference} ref
 * @param {SpecifierChoice} choice
 * @returns {PlannedEdit}
 */
function sourceEdit(code, ref, choice) {
  const slice = code.slice(ref.start, ref.end);
  const quoted = new RegExp(
    `(['"])${ref.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`,
  );
  const m = slice.match(quoted);
  const at = m && m.index != null ? ref.start + m.index : ref.start;
  const length = m ? m[0].length : 0;
  const quote = m ? m[1] : "'";
  return {
    start: at,
    end: at + length,
    render: specifierOf =>
      m ? `${quote}${specifierOf(choice)}${quote}` : slice,
  };
}

/**
 * The statements that replace one named import or re-export, one per source.
 * @param {ModuleReference} ref
 * @param {Array<{choice: SpecifierChoice, specs: ImportSpecifier[]}>} groups
 * @param {(choice: SpecifierChoice) => string} specifierOf
 */
function renderStatements(ref, groups, specifierOf) {
  const keyword = ref.kind === 'reexportNamed' ? 'export' : 'import';
  const statements = [];
  for (const {choice, specs} of groups) {
    const specifier = specifierOf(choice);
    const star = specs.find(s => s.imported === '*');
    if (star) statements.push(`export * as ${star.local} from '${specifier}';`);
    const named = specs.filter(s => s.imported !== '*');
    if (named.length === 0) continue;
    const allType = ref.typeOnly || named.every(s => s.typeOnly);
    const parts = named.map(s => {
      const prefix = !allType && s.typeOnly ? 'type ' : '';
      return s.imported === s.local
        ? `${prefix}${s.local}`
        : `${prefix}${s.imported} as ${s.local}`;
    });
    const head = `${keyword} ${allType ? 'type ' : ''}`;
    const oneLine = `${head}{${parts.join(', ')}} from '${specifier}';`;
    statements.push(
      oneLine.length <= 80
        ? oneLine
        : `${head}{\n${parts.map(p => `  ${p},`).join('\n')}\n} from '${specifier}';`,
    );
  }
  return statements.join('\n');
}

/**
 * The source of a planned file with its edits applied.
 * @param {{code: string, edits: PlannedEdit[]}} planned
 * @param {(choice: SpecifierChoice) => string} specifierOf
 */
export function renderFile(planned, specifierOf) {
  let out = planned.code;
  for (const edit of [...planned.edits].sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, edit.start) + edit.render(specifierOf) + out.slice(edit.end);
  }
  return out;
}

/**
 * The relative specifier from one written file to another.
 * @param {string} fromDest
 * @param {string} toDest
 */
export function relativeSpecifierBetween(fromDest, toDest) {
  let rel = toPosix(path.relative(path.dirname(fromDest), toDest));
  rel = DECLARATION_FILE.test(toDest)
    ? rel.replace(/\.d\.[cm]?ts$/, '')
    : rel.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}
