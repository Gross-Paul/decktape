#!/usr/bin/env node

'use strict';

import chalk             from 'chalk';
import crypto            from 'crypto';
import { Font }          from 'fonteditor-core';
import fs                from 'fs';
import os                from 'os';
import parser            from './libs/nomnom.js';
import path              from 'path';
import puppeteer         from 'puppeteer';
import URI               from 'urijs';
import util              from 'util';
import { fileURLToPath } from 'url';

import { PDFDocument, PDFName, ParseSpeeds, decodePDFRawStream } from 'pdf-lib';

import { delay, pause } from './libs/util.js';

parser.script('decktape').options({
  url : {
    position  : 1,
    required  : true,
    transform : parseUrl,
    help      : 'URL of the slides deck',
  },
  filename : {
    position : 2,
    required : true,
    help     : 'Filename of the output PDF file',
  },
  size : {
    abbr      : 's',
    metavar   : '<size>',
    type      : 'string',
    callback  : parseSize,
    transform : parseSize,
    help      : 'Size of the slides deck viewport: <width>x<height> (e.g. \'1280x720\')',
  },
  pause : {
    abbr    : 'p',
    metavar : '<ms>',
    default : 1000,
    help    : 'Duration in milliseconds before each slide is exported',
  },
  loadPause : {
    full    : 'load-pause',
    metavar : '<ms>',
    default : 0,
    help    : 'Duration in milliseconds between the page has loaded and starting to export slides',
  },
  urlLoadTimeout : {
    full    : 'url-load-timeout',
    metavar : '<ms>',
    default : 60000,
    help    : 'Timeout in milliseconds to use when waiting for the initial URL to load',
  },
  pageLoadTimeout : {
    full    : 'page-load-timeout',
    metavar : '<ms>',
    default : 20000,
    help    : 'Timeout in milliseconds to use when waiting for the slide deck page to load',
  },
  bufferTimeout : {
    full    : 'buffer-timeout',
    metavar : '<ms>',
    default : 30000,
    help    : 'Timeout in milliseconds to use when waiting for a slide to finish buffering (set to 0 to disable)',
  },
  screenshots : {
    default : false,
    flag    : true,
    help    : 'Capture each slide as an image',
  },
  screenshotDirectory : {
    full    : 'screenshots-directory',
    metavar : '<dir>',
    default : 'screenshots',
    help    : 'Screenshots output directory',
  },
  screenshotSizes : {
    full      : 'screenshots-size',
    metavar   : '<size>',
    type      : 'string',
    list      : true,
    callback  : parseSize,
    transform : parseSize,
    help      : 'Screenshots resolution, can be repeated',
  },
  screenshotFormat : {
    full    : 'screenshots-format',
    metavar : '<format>',
    default : 'png',
    choices : ['jpg', 'png'],
    help    : 'Screenshots image format, one of [jpg, png]',
  },
  slides : {
    metavar   : '<range>',
    type      : 'string',
    callback  : parseRange,
    transform : parseRange,
    help      : 'Range of slides to be exported, a combination of slide indexes and ranges (e.g. \'1-3,5,8\')',
  },
  headless : {
    default : 'new', // false to enable headed mode and true to enable old puppeteer headless. See: https://developer.chrome.com/articles/new-headless/#new-headless-in-puppeteer
    help    : 'Puppeteer headless mode, one if [new, true, false]',
  },
  headers : {
    type      : 'string',
    callback  : parseHeaders,
    transform : parseHeaders,
    help      : 'HTTP headers, comma-separated list of <header>,<value> pairs (e.g. "Authorization,\'Bearer ASDJASLKJALKSJDL\'")',
  },
  // Parallelization options
  parallel : {
    metavar   : '<count>',
    default   : 1,
    type      : 'number',
    help      : 'Number of parallel workers to use for PDF export (1-8)',
  },
  // Chrome options
  chromePath : {
    full    : 'chrome-path',
    metavar : '<path>',
    type    : 'string',
    help    : 'Path to the Chromium or Chrome executable to run instead of the bundled Chromium',
  },
  chromeArgs : {
    full    : 'chrome-arg',
    metavar : '<arg>',
    type    : 'string',
    list    : true,
    help    : 'Additional argument to pass to the Chrome instance, can be repeated',
  },
  // PDF meta data
  metaAuthor : {
    full    : 'pdf-author',
    metavar : '<arg>',
    type    : 'string',
    help    : 'String to set as the author of the resulting PDF document',
  },
  metaTitle : {
    full    : 'pdf-title',
    metavar : '<arg>',
    type    : 'string',
    help    : 'String to set as the title of the resulting PDF document',
  },
  metaSubject : {
    full    : 'pdf-subject',
    metavar : '<arg>',
    type    : 'string',
    help    : 'String to set as the subject of the resulting PDF document',
  },
});

function parseHeaders(headerString) {
  const h = headerString.split(",");
  if ((h.length % 2) != 0) {
    return 'header flag must be a comma delimited key value pairing and should always have an even number of kv pairs';
  }
  let headers = {};
  for (let i = 0; i < h.length; i += 2) {
    headers[h[i]] = h[i+1];
  }
  return headers;
}

function parseSize(size) {
  // we may want to support height and width labeled with units
  // /^(\d+(?:px)?|\d+(?:\.\d+)?(?:in|cm|mm)?)\s?x\s?(\d+(?:px)?|\d+(?:\.\d+)?(?:in|cm|mm)?)$/
  const match = size.match(/^(\d+)x(\d+)$/);
  if (match) {
    const [, width, height] = match;
    return { width: parseInt(width, 10), height: parseInt(height, 10) };
  } else {
    return '<size> must follow the <width>x<height> notation, e.g., \'1280x720\'';
  }
}

function parseRange(range) {
  const regex = /(\d+)(?:-(\d+))?/g;
  if (!range.match(regex))
    return '<range> must be a combination of slide indexes and ranges, e.g., \'1-3,5,8\'';
  let slide, slides = {};
  while ((slide = regex.exec(range)) !== null) {
    const [, m, n] = slide.map(i => parseInt(i));
    if (isNaN(n)) {
      slides[m] = true;
    } else {
      for (let i = m; i <= n; i++) {
        slides[i] = true;
      }
    }
  }
  return slides;
}

function parseUrl(url) {
  const uri = URI(url);
  if (!uri.protocol()) {
    if (path.isAbsolute(url)) {
      return 'file://' + path.normalize(url);
    } else {
      return 'file://' + path.normalize(path.join(process.cwd(), url));
    }
  }
  return url;
}

parser.command('version')
  .root(true)
  .help('Display decktape package version')
  .callback(_ => {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
    console.log(pkg.version);
    process.exit();
  });
parser.nocommand()
.help(
`Defaults to the automatic command.
Iterates over the available plugins, picks the compatible one for presentation at the
specified <url> and uses it to export and write the PDF into the specified <filename>.`
);
parser.command('automatic')
.help(
`Iterates over the available plugins, picks the compatible one for presentation at the
specified <url> and uses it to export and write the PDF into the specified <filename>.`
);

// TODO: should be deactivated as well when it does not execute in a TTY context
if (os.name === 'windows') parser.nocolors();

const color = type => {
  switch (type) {
    case 'error': return chalk.red;
    case 'warn': return chalk.yellow;
    default: return chalk.gray;
  }
};

process.on('unhandledRejection', error => {
  console.log(error.stack);
  process.exit(1);
});

(async () => {
  const plugins = await loadAvailablePlugins(path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins'));

  Object.entries(plugins).forEach(([id, plugin]) => {
    const command = parser.command(id);
    if (typeof plugin.options === 'object') {
      command.options(plugin.options);
    }
    if (typeof plugin.help === 'string') {
      command.help(plugin.help);
    }
  });
  const options = parser.parse(process.argv.slice(2));

  // Validate parallel option
  const parallelWorkers = Math.max(1, Math.min(8, options.parallel || 1));
  if (parallelWorkers > 1) {
    console.log(chalk.cyan(`Using ${parallelWorkers} parallel workers for PDF export`));
  }

  // Chromium throttles rendering (including requestAnimationFrame, which most charting
  // libraries rely on to draw) for pages/tabs it doesn't consider foreground. That's
  // invisible with a single page, but --parallel opens several pages in the same browser
  // at once, and only one of them is ever "active" -- the rest get starved and can end up
  // captured before they've actually drawn anything onto their canvases. Disable that
  // backgrounding behavior (including Windows' native window occlusion detection) so every
  // worker page renders normally regardless of focus.
  const backgroundingArgs = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  const browser = await puppeteer.launch({
    headless       : options.headless,
    // TODO: add a verbose option
    // dumpio      : true,
    executablePath : options.chromePath,
    args           : [...backgroundingArgs, ...(options.chromeArgs || [])],
  });
  const page = await browser.newPage();
  if (options.headers)
    page.setExtraHTTPHeaders(options.headers)
  await page.emulateMediaType('screen');
  const pdf = await PDFDocument.create();
  pdf.setCreator('Decktape');
  if (options.metaAuthor)
    pdf.setAuthor(options.metaAuthor);
  if (options.metaSubject)
    pdf.setSubject(options.metaSubject);
  if (options.metaTitle)
    pdf.setTitle(options.metaTitle);

  wirePageDiagnostics(page, options.parallel > 1 ? 'worker 1' : undefined);

  console.log('Loading page', options.url, '...');
  const load = page.waitForNavigation({ waitUntil: 'load', timeout: options.urlLoadTimeout });
  page.goto(options.url, { waitUntil: 'networkidle0', timeout: options.pageLoadTimeout })
    // wait until the load event is dispatched
    .then(response => load
      .catch(error => response.status() !== 200 ? Promise.reject(error) : response)
      .then(_ => response))
    // TODO: improve message when reading file locally
    .then(response => console.log('Loading page finished with status: %s', response.status()))
    .then(delay(options.loadPause))
    .then(_ => createPlugin(page, plugins, options))
    .then(plugin => configurePlugin(plugin)
      .then(_ => configurePage(page, plugin, options))
      .then(_ => parallelWorkers > 1 ? exportSlidesParallel(browser, page, plugin, pdf, options, parallelWorkers, plugins) : exportSlides(page, plugin, pdf, options))
      .then(async context => {
        await writePdf(options.filename, pdf);
        console.log(chalk.green(`\nPrinted ${chalk.bold('%s')} slides`), context.exportedSlides);
        // Wait for the browser to close before exiting the process
        await browser.close();
        process.exit();
      }))
    .catch(async error => {
      console.log(chalk.red('\n%s'), error);
      // Wait for the browser to close before exiting the process
      await browser.close();
      process.exit(1);
    });
})();

async function loadAvailablePlugins(pluginsPath) {
  const plugins = await fs.promises.readdir(pluginsPath);
  const entries = await Promise.all(plugins.map(async pluginPath => {
    const [, plugin] = pluginPath.match(/^(.*)\.js$/);
    if (plugin && (await fs.promises.stat(path.join(pluginsPath, pluginPath))).isFile()) {
      return [plugin, await import(`./plugins/${pluginPath}`)];
    }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

async function createPlugin(page, plugins, options) {
  let plugin;
  if (!options.command || options.command === 'automatic') {
    plugin = await createActivePlugin(page, plugins, options);
    if (!plugin) {
      console.log('No supported DeckTape plugin detected, falling back to generic plugin');
      plugin = plugins['generic'].create(page, options);
    }
  } else {
    plugin = plugins[options.command].create(page, options);
    if (!await plugin.isActive()) {
      throw Error(`Unable to activate the ${plugin.getName()} DeckTape plugin for the address: ${options.url}`);
    }
  }
  console.log(chalk.cyan(`${chalk.bold('%s')} plugin activated`), plugin.getName());
  return plugin;
}

async function createActivePlugin(page, plugins, options) {
  for (let id in plugins) {
    if (id === 'generic') continue;
    const plugin = plugins[id].create(page, options);
    if (await plugin.isActive()) return plugin;
  }
}

async function configurePage(page, plugin, options) {
  if (!options.size) {
    options.size = typeof plugin.size === 'function' ? await plugin.size() : { width: 1280, height: 720 };
  }
  await page.setViewport(options.size);
}

async function configurePlugin(plugin) {
  if (typeof plugin.configure === 'function') {
    await plugin.configure();
  }
}

// Surfaces in-page console output, page errors and failed requests to the terminal.
// Must be attached to every page (primary and workers): worker pages previously had
// no listeners at all, so any JS error or resource failure happening on them (e.g. a
// charting library failing to initialize) was silently swallowed.
function wirePageDiagnostics(page, label) {
  const prefix = label ? chalk.gray(`[${label}] `) : '';
  page
    .on('console', async msg => {
      if (msg.type() === 'log') {
        const args = await Promise.all(msg.args().map(arg => arg.evaluate(obj => obj, arg)));
        console.log(prefix + args.map(arg => color(msg.type())(util.format(arg))).join(' '));
      } else {
        console.log(prefix + color(msg.type())(util.format(msg.text())));
      }
    })
    .on('requestfailed', request => {
      // do not output warning for cancelled requests
      if (request.failure() && request.failure().errorText === 'net::ERR_ABORTED') return;
      console.log(chalk.yellow('\n%sUnable to load resource from URL: %s'), prefix, request.url());
    })
    .on('pageerror', error => console.log(chalk.red('\n%sPage error: %s'), prefix, error.message));
}

/**
 * Export slides with parallel processing.
 * Each worker owns a dedicated Puppeteer page and walks the deck from slide 1
 * using the plugin's own nextSlide()/hasNextSlide() API (same as sequential mode),
 * only pausing and capturing a PDF once it reaches its assigned range. This keeps
 * navigation correct for every plugin (not just reveal.js) and guarantees two
 * workers never touch the same page concurrently.
 */
async function exportSlidesParallel(browser, primaryPage, plugin, pdf, options, parallelWorkers, allPlugins) {
  if (options.screenshots) {
    console.log(chalk.yellow('\n--screenshots is not yet supported with --parallel; falling back to sequential export.'));
    return exportSlides(primaryPage, plugin, pdf, options);
  }

  const totalSlides = await plugin.slideCount();
  if (!totalSlides) {
    console.log(chalk.yellow(
      `\n${plugin.getName()} plugin cannot report a total slide count in advance, so work cannot be ` +
      `split across parallel workers; falling back to sequential export.`));
    return exportSlides(primaryPage, plugin, pdf, options);
  }

  const maxSlide = options.slides
    ? Math.min(totalSlides, Math.max(...Object.keys(options.slides)))
    : totalSlides;
  const workerCount = Math.max(1, Math.min(parallelWorkers, maxSlide));
  if (workerCount === 1) {
    return exportSlides(primaryPage, plugin, pdf, options);
  }
  if (workerCount < parallelWorkers) {
    console.log(chalk.yellow(`\nOnly ${maxSlide} slide(s) to export; using ${workerCount} worker(s) instead of ${parallelWorkers}.`));
  }

  const ranges = partitionSlideRanges(maxSlide, workerCount);

  // Create one dedicated page/plugin instance per worker (primary page covers the first range)
  const workerPages = [primaryPage];
  const workerPlugins = [plugin];

  for (let i = 1; i < ranges.length; i++) {
    const workerPage = await browser.newPage();
    if (options.headers)
      workerPage.setExtraHTTPHeaders(options.headers)
    await workerPage.emulateMediaType('screen');
    wirePageDiagnostics(workerPage, `worker ${i + 1}`);

    console.log(`Initializing worker ${i + 1}/${ranges.length}...`);
    await workerPage.goto(options.url, { waitUntil: 'networkidle0', timeout: options.pageLoadTimeout });
    await pause(options.loadPause);

    const workerPlugin = await createPlugin(workerPage, allPlugins, options);
    await configurePlugin(workerPlugin);
    await configurePage(workerPage, workerPlugin, options);

    workerPages.push(workerPage);
    workerPlugins.push(workerPlugin);
  }

  console.log(`Exporting up to ${maxSlide} slides with ${ranges.length} workers...`);

  // Chromium shares a single GPU/rasterizer process across pages, so calling page.pdf()
  // concurrently from multiple workers can capture canvas-based content (e.g. Chart.js)
  // before it's composited, silently dropping it from the output. Slide navigation and
  // settling still run fully in parallel; only the final PDF snapshot is serialized.
  const pdfMutex = createMutex();

  const progress = { captured: 0, expected: maxSlide };
  const results = await Promise.all(ranges.map((range, i) => captureSlideRange(
    workerPages[i], workerPlugins[i], range,
    { isLastWorker: i === ranges.length - 1, hasExplicitSlideCap: !!options.slides, totalSlides },
    options, progress, pdfMutex
  )));

  process.stdout.write('\n');

  const context = {
    progressBarOverflow : 0,
    currentSlide        : 1,
    exportedSlides      : 0,
    pdfFonts            : {},
    pdfXObjects         : {},
    totalSlides,
  };

  // Assemble exported slides in order; sorting (rather than relying on a precomputed
  // slide list) tolerates the last worker walking past its nominal range end.
  const captured = results.flat().sort((a, b) => a.slideNum - b.slideNum);
  for (const { buffer } of captured) {
    await printSlide(pdf, await PDFDocument.load(buffer, { parseSpeed: ParseSpeeds.Fastest }), context);
    context.exportedSlides++;
  }

  // Flush consolidated fonts
  Object.values(context.pdfFonts).forEach(({ ref, font }) => {
    pdf.context.assign(ref, pdf.context.flateStream(font.write({ type: 'ttf', hinting: true })));
  });

  // Close worker pages (except the primary)
  for (let i = 1; i < workerPages.length; i++) {
    await workerPages[i].close();
  }

  return context;
}

/**
 * Serializes async work submitted from multiple workers so only one runs at a time,
 * without blocking workers from continuing their own unrelated (non-serialized) work.
 */
function createMutex() {
  let tail = Promise.resolve();
  return fn => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  };
}

/**
 * Split [1, maxSlide] into workerCount contiguous ranges of near-equal size.
 */
function partitionSlideRanges(maxSlide, workerCount) {
  const base = Math.floor(maxSlide / workerCount);
  const remainder = maxSlide % workerCount;
  const ranges = [];
  let start = 1;
  for (let i = 0; i < workerCount; i++) {
    const size = base + (i < remainder ? 1 : 0);
    const end = start + size - 1;
    ranges.push({ start, end });
    start = end + 1;
  }
  return ranges;
}

/**
 * Walk a deck on a dedicated page from slide 1 up to (at least) range.end, capturing
 * only the slides that fall within this worker's range and are selected by --slides.
 * Slides outside the range are pure transit: no pause, since nothing is ever rendered
 * from them (this intentionally diverges from the sequential loop, which pauses even
 * on skipped slides -- there's nothing to let "settle" on a slide never captured).
 */
async function captureSlideRange(page, plugin, range, meta, options, progress, pdfMutex) {
  const localContext = { currentSlide: 1, totalSlides: meta.totalSlides };
  const buffers = [];
  // Only the last worker, and only absent an explicit --slides cap, may walk past its
  // nominal range end -- guards against plugins whose slideCount() undercounts (e.g.
  // reveal.js stacks/fragments) so the tail of the deck is never silently dropped.
  const hardCap = (meta.isLastWorker && !meta.hasExplicitSlideCap) ? Infinity : range.end;

  const maybeCapture = async () => {
    const n = localContext.currentSlide;
    if (n < range.start || n > range.end) return;
    if (options.slides && !options.slides[n]) return;
    await pause(options.pause);
    buffers.push({ slideNum: n, buffer: await captureSlideBuffer(page, options, pdfMutex) });
    progress.captured++;
    process.stdout.write('\r' + `Rendering slides ${progress.captured}/${progress.expected} ...`);
  };

  await maybeCapture();
  let hasNext = await hasNextSlide(plugin, localContext);
  while (hasNext && localContext.currentSlide < hardCap) {
    await nextSlide(plugin, localContext);
    await maybeCapture();
    hasNext = await hasNextSlide(plugin, localContext);
  }
  return buffers;
}

async function exportSlides(page, plugin, pdf, options) {
  const context = {
    progressBarOverflow : 0,
    currentSlide        : 1,
    exportedSlides      : 0,
    pdfFonts            : {},
    pdfXObjects         : {},
    totalSlides         : await plugin.slideCount(),
  };
  // TODO: support a more advanced "fragment to pause" mapping
  // for special use cases like GIF animations
  // TODO: support plugin optional promise to wait until a particular mutation
  // instead of a pause
  if (options.slides && !options.slides[context.currentSlide]) {
    process.stdout.write('\r' + await progressBar(plugin, context, { skip: true }));
  } else {
    await pause(options.pause);
    await exportSlide(page, plugin, pdf, context, options);
  }
  const maxSlide = options.slides ? Math.max(...Object.keys(options.slides)) : Infinity;
  let hasNext = await hasNextSlide(plugin, context);
  while (hasNext && context.currentSlide < maxSlide) {
    await nextSlide(plugin, context);
    await pause(options.pause);
    if (options.slides && !options.slides[context.currentSlide]) {
      process.stdout.write('\r' + await progressBar(plugin, context, { skip: true }));
    } else {
      await exportSlide(page, plugin, pdf, context, options);
    }
    hasNext = await hasNextSlide(plugin, context);
  }
  // Flush consolidated fonts
  Object.values(context.pdfFonts).forEach(({ ref, font }) => {
    pdf.context.assign(ref, pdf.context.flateStream(font.write({ type: 'ttf', hinting: true })));
  });
  return context;
}

async function exportSlide(page, plugin, pdf, context, options) {
  process.stdout.write('\r' + await progressBar(plugin, context));

  const buffer = await captureSlideBuffer(page, options);
  await printSlide(pdf, await PDFDocument.load(buffer, { parseSpeed: ParseSpeeds.Fastest }), context);
  context.exportedSlides++;

  if (options.screenshots) {
    for (let resolution of options.screenshotSizes || [options.size]) {
      await page.setViewport(resolution);
      // Delay page rendering to wait for the resize event to complete,
      // e.g. for impress.js (may be needed to be configurable)
      await pause(1000);
      await page.screenshot({
        path: path.join(options.screenshotDirectory, options.filename
          .replace('.pdf', `_${context.currentSlide}_${resolution.width}x${resolution.height}.${options.screenshotFormat}`)),
        fullPage: false,
        omitBackground: true,
      });
      await page.setViewport(options.size);
      await pause(1000);
    }
  }
}

// Pauses videos and seeks them to start to ensure deterministic rendering, then
// exports the current slide as a single-page PDF buffer. Shared by both the
// sequential and parallel export paths so they can never silently diverge.
async function captureSlideBuffer(page, options, pdfMutex) {
  await page.evaluate(() => document.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 0; }));
  await debugLogCanvases(page);
  const capture = () => page.pdf({
    width               : options.size.width,
    height              : options.size.height,
    printBackground     : true,
    pageRanges          : '1',
    displayHeaderFooter : false,
    timeout             : options.bufferTimeout,
  });
  return pdfMutex ? pdfMutex(capture) : capture();
}

// TEMPORARY diagnostic to pin down why some canvases (e.g. Chart.js) come out blank
// specifically under --parallel. Logs, for every <canvas> on the page right before it's
// captured, its pixel size, which slide section it belongs to, whether that slide is
// currently visible, and whether it holds any non-transparent pixel data. Remove once
// the root cause is confirmed.
async function debugLogCanvases(page) {
  const canvases = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map(c => {
    let hasContent;
    try {
      const ctx = c.getContext('2d');
      hasContent = ctx && c.width && c.height
        ? Array.from(ctx.getImageData(0, 0, c.width, c.height).data).some(v => v !== 0)
        : false;
    } catch (e) {
      hasContent = `error: ${e.message}`;
    }
    const slide = c.closest('section');
    return {
      id       : c.id || '(no id)',
      size     : `${c.width}x${c.height}`,
      slideId  : slide ? (slide.id || '(no id)') : null,
      visible  : slide ? getComputedStyle(slide).display !== 'none' : null,
      hasContent,
    };
  }));
  if (canvases.length) {
    console.log('[canvas-check]', JSON.stringify(canvases));
  }
}

async function printSlide(pdf, slide, context) {
  const duplicatedEntries = [];
  const [page] = await pdf.copyPages(slide, [0]);

  pdf.addPage(page);
  // Traverse the page to consolidate duplicates
  parseResources(page.node);
  // And delete all the collected duplicates
  duplicatedEntries.forEach(ref => pdf.context.delete(ref));

  function parseResources(dictionary) {
    const resources = dictionary.get(PDFName.Resources);
    if (resources.has(PDFName.XObject)) {
      const xObject = resources.get(PDFName.XObject);
      xObject.entries().forEach(entry => parseXObject(entry, xObject));
    }
    if (resources.has(PDFName.Font)) {
      resources.get(PDFName.Font).entries().forEach(parseFont);
    }
  }

  function parseXObject([name, entry], xObject) {
    const object = page.node.context.lookup(entry);
    const subtype = object.dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Image')) {
      const digest = crypto.createHash('SHA1').update(object.contents).digest('hex');
      const existing = context.pdfXObjects[digest];
      if (!existing) {
        // Store the entry that'll replace references with the same content
        context.pdfXObjects[digest] = entry;
      } else if (entry !== existing) {
        // Only remove references from different pages
        xObject.set(name, context.pdfXObjects[digest]);
        duplicatedEntries.push(entry);
      }
    } else {
      parseResources(object.dict);
    }
  };

  function parseFont([_, entry]) {
    const object = page.node.context.lookup(entry);
    const subtype = object.get(PDFName.of('Subtype'));
    // See "Introduction to Font Data Structures" from PDF specification
    if (subtype === PDFName.of('Type0')) {
      // TODO: properly support composite fonts with multiple descendants
      const descendant = page.node.context.lookup(object.get(PDFName.of('DescendantFonts')).get(0));
      if (descendant.get(PDFName.of('Subtype')) === PDFName.of('CIDFontType2')) {
        const descriptor = page.node.context.lookup(descendant.get(PDFName.of('FontDescriptor')));
        const ref = descriptor.get(PDFName.of('FontFile2'));
        const file = page.node.context.lookup(ref);
        if (!file) {
          // The font has already been processed and removed
          return;
        }
        const bytes = decodePDFRawStream(file).decode();
        let font;
        try {
          // Some fonts written in the PDF may be ill-formed. Let's skip font compression in that case,
          // until it's fixed in Puppeteer > Chromium > Skia.
          // This happens for system fonts like Helvetica Neue for which cmap table is missing.
          font = Font.create(Buffer.from(bytes), { type: fontType(bytes), hinting: true });
        } catch (e) {
          console.log(chalk.yellow('\nSkipping font compression: %s'), e.message);
          return;
        }
        // Some fonts happen to miss some metadata and tables required by fonteditor
        if (!font.data.name) {
          font.data.name = {};
        }
        if (!font.data['OS/2']) {
          font.data['OS/2'] = {};
        }
        // PDF font name does not contain sub family on Windows 10,
        // so a more robust key is computed from the font metadata
        const id = descriptor.get(PDFName.of('FontName')).value() + ' - ' + fontMetadataKey(font.data.name);
        if (context.pdfFonts[id]) {
          const f = context.pdfFonts[id].font;
          // Build a unicode-to-index map for the target font so that glyphs are
          // matched by unicode value rather than by index. Fonts with the same name
          // may assign different indices to the same glyphs (e.g. SVG-embedded fonts),
          // and merging by index alone can produce duplicate unicode mappings (#389).
          const targetUnicodeToIndex = new Map();
          f.data.glyf.forEach((fg, idx) => {
            if (fg.unicode) {
              fg.unicode.forEach(u => targetUnicodeToIndex.set(u, idx));
            }
          });
          font.data.glyf.forEach((g, i) => {
            let targetIndex = i;
            if (g.unicode) {
              const existingIndex = g.unicode.map(u => targetUnicodeToIndex.get(u)).find(idx => idx !== undefined);
              if (existingIndex !== undefined) {
                targetIndex = existingIndex;
              }
            }
            if (g.contours && g.contours.length > 0) {
              if (!f.data.glyf[targetIndex] || !f.data.glyf[targetIndex].contours || f.data.glyf[targetIndex].contours.length === 0) {
                mergeGlyph(f, targetIndex, g);
              }
            } else if (g.compound) {
              if (!f.data.glyf[targetIndex] || typeof f.data.glyf[targetIndex].compound === 'undefined') {
                mergeGlyph(f, targetIndex, g);
              }
            }
          });
          descriptor.set(PDFName.of('FontFile2'), context.pdfFonts[id].ref);
          duplicatedEntries.push(ref);
        } else {
          context.pdfFonts[id] = { ref: ref, font: font };
        }
      }
    }
  };

  function fontType(bytes) {
    const buffer = Buffer.from(bytes);
    if (buffer.readInt32BE() === 0x10000) {
      return 'ttf';
    }
    if (buffer.toString('utf8', 0, 4) === 'OTTO') {
      return 'otf';
    }
  }

  function mergeGlyph(font, index, glyf) {
    if (font.data.glyf.length <= index) {
      for (let i = font.data.glyf.length; i < index; i++) {
        font.data.glyf.push({ contours: Array(0), advanceWidth: 0, leftSideBearing: 0 });
      }
      font.data.glyf.push(glyf);
    } else {
      font.data.glyf[index] = glyf;
    }
  }

  function fontMetadataKey(font) {
    const keys = ['fontFamily', 'fontSubFamily', 'fullName', 'preferredFamily', 'preferredSubFamily', 'uniqueSubFamily'];
    return Object.entries(font)
      .filter(([key, _]) => keys.includes(key))
      .reduce((r, [k, v], i) => r + (i > 0 ? ',' : '') + k + '=' + v, '');
  }
}

async function hasNextSlide(plugin, context) {
  if (typeof plugin.hasNextSlide === 'function') {
    return await plugin.hasNextSlide();
  } else {
    return context.currentSlide < context.totalSlides;
  }
}

async function nextSlide(plugin, context) {
  context.currentSlide++;
  return plugin.nextSlide();
}

async function writePdf(filename, pdf) {
  const pdfDir = path.dirname(filename);
  try {
    fs.accessSync(pdfDir, fs.constants.F_OK);
  } catch {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  fs.writeFileSync(filename, await pdf.save({ addDefaultPage: false }));
}

// TODO: add progress bar, duration, ETA and file size
async function progressBar(plugin, context, { skip } = { skip: false }) {
  const cols = [];
  const index = await plugin.currentSlideIndex();
  cols.push(`${skip ? 'Skipping' : 'Printing'} slide `);
  cols.push(`#${index}`.padEnd(8));
  cols.push(' (');
  cols.push(`${context.currentSlide}`.padStart(context.totalSlides ? context.totalSlides.toString().length : 3));
  cols.push('/');
  cols.push(context.totalSlides || ' ?');
  cols.push(') ...');
  // erase overflowing slide fragments
  cols.push(' '.repeat(Math.max(context.progressBarOverflow - Math.max(index.length + 1 - 8, 0), 0)));
  context.progressBarOverflow = Math.max(index.length + 1 - 8, 0);
  return cols.join('');
}
