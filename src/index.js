// @flow

import { relative, dirname, join } from "path";
import { minify } from "terser";
import gzipSize from "gzip-size";
import bytes from "bytes";
import chalk from "chalk";
import { treeshakeWithRollup } from "./treeshakeWithRollup.js";
import { treeshakeWithWebpack } from "./treeshakeWithWebpack.js";
import * as snapshot from "./snapshot.js";

type Options = {
  snapshotPath?: string,
  matchSnapshot?: boolean,
  threshold?: number,
  printInfo?: boolean,
};

type OutputOptions = {
  format: string,
  file: string,
};

type Plugin = {
  name: string,
  renderChunk: (
    code: string,
    chunk: any,
    options: OutputOptions
  ) => null | Promise<null>,
};

const validateOptions = (options) => {
  const optionsKeys: $ReadOnlyArray<$Keys<Options>> = [
    "snapshotPath",
    "matchSnapshot",
    "threshold",
    "printInfo",
  ];

  const invalidKeys = Object.keys(options).filter(
    (d) => !optionsKeys.includes(d)
  );

  const wrap = (d) => `"${d}"`;

  if (1 === invalidKeys.length) {
    throw Error(`Option ${wrap(invalidKeys[0])} is invalid`);
  }

  if (1 < invalidKeys.length) {
    throw Error(`Options ${invalidKeys.map(wrap).join(", ")} are invalid`);
  }
};

const bytesConfig = { thousandsSeparator: ",", unitSeparator: " ", unit: "B" };

const formatSize = (d) => chalk.bold(bytes.format(d, bytesConfig));

export const sizeSnapshot = (options?: Options = {}): Plugin => {
  validateOptions(options);

  const snapshotPath =
    options.snapshotPath || join(process.cwd(), ".size-snapshot.json");
  const shouldMatchSnapshot = options.matchSnapshot === true;
  const shouldPrintInfo = options.printInfo !== false;
  const threshold = options.threshold == null ? 0 : options.threshold;

  return {
    name: "size-snapshot",

    async renderChunk(rawSource, chunk, outputOptions) {
      // remove windows specific newline character
      const source = rawSource.replace(/\r/g, "");
      const format = outputOptions.format;
      const shouldTreeshake = format === "es" || format === "esm";

      const outputName = chunk.fileName;

      // Cleaner error reporting was discussed in
      // brodybits/rollup-plugin-size-snapshot#17
      // but a reproduction is needed to add a test case, see
      // https://github.com/brodybits/rollup-plugin-size-snapshot/issues/19
      const minifyResult = await minify(source);
      const minified = minifyResult.code;
      if (!minified && minified !== "") {
        // TODO needs test case with a reproduction, see
        // https://github.com/brodybits/rollup-plugin-size-snapshot/issues/19
        throw new Error(
          "INTERNAL ERROR - terser error - see https://github.com/brodybits/rollup-plugin-size-snapshot/issues/19 " +
            JSON.stringify(minifyResult)
        );
      }

      const treeshakeSize = (code) =>
        Promise.all([treeshakeWithRollup(code), treeshakeWithWebpack(code)]);

      return Promise.all([
        gzipSize(minified),
        shouldTreeshake
          ? treeshakeSize(source)
          : [{ code: 0, import_statements: 0 }, { code: 0 }],
      ]).then(([gzippedSize, [rollupSize, webpackSize]]) => {
        const sizes: Object = {
          bundled: source.length,
          minified: minified.length,
          gzipped: gzippedSize,
        };

        const prettyFormat = format === "es" ? "esm" : format;
        const prettyBundled = formatSize(sizes.bundled);
        const prettyMinified = formatSize(sizes.minified);
        const prettyGzipped = formatSize(sizes.gzipped);
        let infoString =
          "\n" +
          `Computed sizes of "${outputName}" with "${prettyFormat}" format\n` +
          `  bundler parsing size: ${prettyBundled}\n` +
          `  browser parsing size (minified with terser): ${prettyMinified}\n` +
          `  download size (minified and gzipped): ${prettyGzipped}\n`;

        const formatMsg = (msg, size) => `  ${msg}: ${formatSize(size)}\n`;

        if (shouldTreeshake) {
          sizes.treeshaked = {
            rollup: rollupSize,
            webpack: webpackSize,
          };

          infoString += formatMsg(
            "treeshaked with rollup with production NODE_ENV and minified",
            rollupSize.code
          );
          infoString += formatMsg(
            "  import statements size of it",
            rollupSize.import_statements
          );
          infoString += formatMsg(
            "treeshaked with webpack in production mode",
            webpackSize.code
          );
        }

        const snapshotParams = {
          snapshotPath,
          name: outputName,
          data: sizes,
          threshold,
        };
        if (shouldMatchSnapshot) {
          snapshot.match(snapshotParams);
        } else {
          if (shouldPrintInfo) {
            console.info(infoString);
          }
          snapshot.write(snapshotParams);
        }

        return null;
      });
    },
  };
};
