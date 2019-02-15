import * as doctrine from "doctrine";
import * as minimist from "minimist";
import * as path from "path";
import { generateSchema } from "../generate-schema";
import { generateSwagger } from "../generate-swagger";
import { showHelp } from "../util";

import { AST_NODE_TYPES, parse } from "@typescript-eslint/typescript-estree";
import {
  TSTypeAliasDeclaration,
  TSTypeReference
} from "@typescript-eslint/typescript-estree/dist/typedefs";
import { ExportNamedDeclaration, Identifier } from "estree";
import * as fs from "fs";
import * as YAML from "json2yaml";
import { Definition } from "typescript-json-schema";

const usage = `
Usage: agreed-typed gen-swagger [options]
Options:
  --path                             Agreed file path (required)
  --title                            swagger title
  --minify                           minify json (only affects json default: false)
  --description                      swagger description
  --version                          document version
  --depth                            aggregate depth (default = 2)
  --dry-run                          dry-run mode (outputs on stdout)
  --output                           output filename (default schema.json)
  --host                             swagger host (default localhost:3030)
  --format                           file format (default json) 
  --help                             show help
  --disable-path-number              disable number type for path params (default: false)
Examples:
  agreed-typed gen-swagger --path ./agreed.ts --output schema.json
`.trim();

export function generate(arg) {
  const argv = minimist(arg, {
    string: [
      "path",
      "title",
      "description",
      "version",
      "depth",
      "output",
      "host",
      "format"
    ],
    boolean: ["dry-run", "disable-path-number", "minify"]
  });

  if (argv.help) {
    showHelp(0, usage);
    return;
  }

  if (!argv.path) {
    showHelp(1, usage);
    return;
  }

  const depth = argv.depth ? Number(argv.depth) : 2;

  const swagger = run({
    path: argv.path,
    description: argv.description,
    version: argv.version,
    depth,
    title: argv.title,
    host: argv.host,
    disablePathNumber: argv["disable-path-number"]
  });

  write(swagger, {
    dryRun: argv["dry-run"],
    format: argv.format,
    filename: argv.output,
    minify: argv.minify
  });
}

function write(
  obj,
  { dryRun, format, filename, minify } = {
    dryRun: true,
    format: "json",
    filename: "schema",
    minify: false
  }
) {
  const output =
    format === "yaml"
      ? "# auto generated by agreed-typed\n" + YAML.stringify(obj)
      : minify
        ? JSON.stringify(obj)
        : JSON.stringify(obj, null, 4);
  if (dryRun) {
    process.stdout.write(output);
    return;
  }
  fs.writeFileSync(
    path.resolve(process.cwd(), `${filename || "schema"}.${format || "json"}`),
    output
  );
}

// testing entry point
export function run({
  path: pt,
  depth,
  title,
  description,
  version,
  host,
  disablePathNumber
}) {
  const agreedPath = path.resolve(process.cwd(), pt);
  require(agreedPath);

  const currentModule = require.main.children.find(
    m => m.filename === __filename
  );

  const agreedRoot = currentModule.children.find(
    m => m.filename === agreedPath
  );

  const { mods, files } = aggregateModules(agreedRoot, depth);

  const metaInfos = mods.reduce((p, a) => {
    p = p.concat(...a.asts.map(m => m.meta));
    return p;
  }, []);

  const schemas = generateSchema(files, metaInfos);
  const defs = schemas.filter(s => s.schema.definitions).reduce((p, c) => {
    return {
      ...p,
      ...c.schema.definitions
    };
  }, {});

  const specs = schemas.reduce((prev: ReducedSpec[], current) => {
    const exist = prev.find(p => {
      return isSamePath(p.path, current.path);
    });
    if (exist) {
      exist.schemas.push(current);
      return prev;
    }
    prev.push({ path: current.path, schemas: [current] });
    return prev;
  }, []);
  return generateSwagger(
    specs,
    title,
    description,
    version,
    host,
    defs,
    disablePathNumber
  );
}

export interface ReducedSpec {
  path: string[];
  schemas: Array<{
    name: string;
    path: string[];
    doc: object;
    schema: Definition;
  }>;
}

function aggregateModules(mod: NodeModule, lim = 2) {
  const files = [];
  const rec = (module: NodeModule, asts, depth, limit) => {
    if (depth >= limit || files.includes(module.filename)) {
      return asts;
    }
    if (
      module.filename.endsWith(".ts") &&
      !module.filename.includes("node_modules")
    ) {
      files.push(module.filename);
      const file = fs.readFileSync(module.filename, "utf-8");
      const ast = parse(file, { comment: true });

      const docs = ast.comments
        .filter(c => {
          return c.type === "Block";
        })
        .reduce((p, d) => {
          const comment = `/*${d.value}*/`;
          const docAST = doctrine.parse(comment, { unwrap: true });
          p[d.loc.end.line] = { ast: docAST };
          return p;
        }, {});

      const mods = ast.body.reduce((prev, current) => {
        if (current.type !== AST_NODE_TYPES.ExportNamedDeclaration) {
          return prev;
        }
        const c: ExportNamedDeclaration = current as any;

        if (
          (c.declaration.type as any) !== AST_NODE_TYPES.TSTypeAliasDeclaration
        ) {
          return prev;
        }

        const declaration = (c.declaration as any) as TSTypeAliasDeclaration;

        if (
          declaration.typeAnnotation.type !== AST_NODE_TYPES.TSTypeReference
        ) {
          return prev;
        }

        const annotation: TSTypeReference = declaration.typeAnnotation;

        if ((annotation.typeName as Identifier).name === "APIDef") {
          const params: any = annotation.typeParameters;

          const pathArr = params.params[1].elementTypes.map(p => {
            if (p.literal) {
              return p.literal.value; // string
            }
            return p.typeParameters.params[0].literal.value;
          });

          const doc = docs[c.declaration.loc.start.line - 1];
          prev.push({
            meta: {
              name: declaration.id.name,
              path: pathArr,
              doc
            },
            ast: current
          });
        }

        return prev;
      }, []);

      if (mods.length > 0) {
        asts.push({ filename: module.filename, asts: mods });
      }
    }

    module.children.forEach(m => {
      rec(m, asts, depth + 1, limit);
    });

    return asts;
  };

  return { mods: rec(mod, [], 0, lim), files };
}

function isSamePath(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let equal = true;
  a.forEach((r, i) => {
    const l = b[i];
    if (r === l) {
      return;
    }
    if (r.startsWith(":") && l.startsWith(":")) {
      return;
    }

    equal = false;
  });

  return equal;
}
