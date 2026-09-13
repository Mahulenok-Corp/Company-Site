#!/usr/bin/env node
/**
 * Сборка сайта: шаблоны из src/ + значения из site.config.json → готовые файлы в dist/.
 * Зависимостей нет, нужен Node.js 18+.
 *
 *   node configure.mjs
 *
 * Синтаксис шаблонов (упрощённый Mustache):
 *   {{key}}               значение с HTML-экранированием
 *   {{{key}}}             значение без экранирования
 *   {{#key}} … {{/key}}   блок: для массива повторяется, для true/непустой строки выводится один раз
 *   {{^key}} … {{/key}}   блок выводится, если значение пустое
 *   {{.}}                 текущий элемент массива строк
 *   {{> name}}            вставка файла src/_partials/name.html
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const partialsDir = join(srcDir, '_partials');
const outDir = join(root, 'dist');
const configPath = join(root, 'site.config.json');

const TEXT_EXT = new Set(['.html', '.xml', '.txt', '.svg', '.css', '.json', '.webmanifest']);
const warnings = [];
const warn = (message) => warnings.push(message);
const fail = (message) => { console.error(`✖ ${message}`); process.exit(1); };
const str = (value) => (typeof value === 'string' ? value.trim() : '');

// ---------- 1. Конфиг ----------
if (!existsSync(configPath)) fail('Нет файла site.config.json рядом с configure.mjs');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`site.config.json — невалидный JSON: ${error.message}`);
}

for (const key of ['orgName', 'domain', 'email']) {
  if (!str(config[key])) fail(`В site.config.json не заполнено обязательное поле "${key}"`);
}

const domain = str(config.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const siteUrl = (str(config.siteUrl) || `https://${domain}`).replace(/\/+$/, '');
let basePath = '';
try {
  const parsed = new URL(siteUrl);
  if (parsed.protocol !== 'https:') warn(`siteUrl = ${siteUrl}: сайт должен открываться по HTTPS, иначе Google его не примет.`);
  basePath = parsed.pathname.replace(/\/+$/, ''); // '' для корня домена, '/Company-Site' для проектного сайта GitHub Pages
} catch {
  fail(`siteUrl = "${siteUrl}" — не похоже на URL. Пример: https://example.com или https://user.github.io/repo`);
}
const isFreeSubdomain = /\.(github\.io|netlify\.app|vercel\.app|pages\.dev|web\.app|firebaseapp\.com|surge\.sh)$/.test(domain);

if (domain === 'example.com') warn('domain = "example.com". Укажите свой домен — иначе сайт нельзя будет подтвердить.');
if (/@example\.com$/i.test(str(config.email))) warn('email оканчивается на @example.com — замените на реальный адрес.');
if (/\bexample\b/i.test(JSON.stringify(config))) warn('В site.config.json остались примерные значения (Example …) — проверьте название, адрес и список приложений.');
if (isFreeSubdomain) warn(`${domain} — бесплатный поддомен хостинга. Search Console его подтвердит, но Google Play может не принять такой сайт как принадлежащий организации. Надёжнее собственный домен.`);
if (/^\s*</.test(str(config.googleSiteVerification))) fail('googleSiteVerification: вставьте только значение атрибута content="…", а не весь тег <meta>.');

const about = Array.isArray(config.about)
  ? config.about.map(str).filter(Boolean)
  : str(config.about).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const apps = Array.isArray(config.apps) ? config.apps.filter((app) => app && str(app.name)) : [];
const facts = Array.isArray(config.facts) ? config.facts.filter((fact) => fact && str(fact.label)) : [];

const view = {
  ...config,
  domain,
  siteUrl,
  basePath,
  about,
  apps,
  facts,
  hasApps: apps.length > 0,
  orgName: str(config.orgName),
  legalName: str(config.legalName) || str(config.orgName),
  email: str(config.email),
  supportEmail: str(config.supportEmail) || str(config.email),
  address: str(config.address),
  country: str(config.country),
  heroLabel: str(config.heroLabel),
  tagline: str(config.tagline) || str(config.orgName),
  description: str(config.description),
  accentColor: str(config.accentColor) || '#2f5bea',
  logoLetter: (str(config.logoLetter) || str(config.orgName)).charAt(0).toUpperCase(),
  googleSiteVerification: str(config.googleSiteVerification),
  lastUpdated: str(config.lastUpdated) || new Date().toISOString().slice(0, 10),
  year: new Date().getFullYear(),
};

// Разметка schema.org/Organization — помогает Google связать сайт с организацией.
view.jsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: view.orgName,
  legalName: view.legalName,
  url: `${siteUrl}/`,
  logo: `${siteUrl}/assets/logo.svg`,
  email: view.email,
  ...(view.address
    ? { address: { '@type': 'PostalAddress', streetAddress: view.address, ...(view.country ? { addressCountry: view.country } : {}) } }
    : {}),
  contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', email: view.supportEmail }],
}, null, 2);

// ---------- 2. Мини-шаблонизатор ----------
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lookup(key, ctx, stack) {
  if (key === '.') return ctx;
  for (const frame of [ctx, ...stack]) {
    if (frame && typeof frame === 'object' && key in frame) return frame[key];
  }
  return undefined;
}

const partialCache = new Map();
function partial(name) {
  if (!partialCache.has(name)) {
    const file = join(partialsDir, `${name}.html`);
    if (!existsSync(file)) fail(`Нет файла для вставки {{> ${name}}}: ${relative(root, file)}`);
    partialCache.set(name, readFileSync(file, 'utf8'));
  }
  return partialCache.get(name);
}

function expandPartials(template, depth = 0) {
  if (depth > 10) fail('Слишком глубокая вложенность {{> …}} — возможно, зацикливание.');
  return template.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => expandPartials(partial(name), depth + 1));
}

const SECTION_RE = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const VAR_RE = /\{\{(\{?)\s*([\w.]+)\s*\}?\}\}/g;

function render(template, ctx, stack = [], file = '') {
  const withSections = expandPartials(template).replace(SECTION_RE, (_, type, key, body) => {
    const value = lookup(key, ctx, stack);
    const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (type === '^') return truthy ? '' : render(body, ctx, stack, file);
    if (!truthy) return '';
    if (Array.isArray(value)) return value.map((item) => render(body, item, [ctx, ...stack], file)).join('');
    if (typeof value === 'object') return render(body, value, [ctx, ...stack], file);
    return render(body, ctx, stack, file);
  });
  return withSections.replace(VAR_RE, (match, raw, key) => {
    const value = lookup(key, ctx, stack);
    if (value === undefined || value === null) { warn(`${file}: нет значения для ${match}`); return ''; }
    if (typeof value === 'object') { warn(`${file}: ${match} — это массив/объект, ожидалась строка`); return ''; }
    return raw ? String(value) : escapeHtml(value);
  });
}

// ---------- 3. Сборка ----------
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === partialsDir) continue;
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (name !== '.DS_Store') files.push(path);
  }
  return files;
}

if (!existsSync(srcDir)) fail('Нет папки src/ с шаблонами');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const dest = join(outDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const isVerificationFile = /^google[0-9a-f]+\.html$/i.test(basename(file)); // файл подтверждения Search Console копируется как есть
  if (TEXT_EXT.has(extname(file).toLowerCase()) && !isVerificationFile) {
    const rendered = render(readFileSync(file, 'utf8'), view, [], rel);
    const leftover = rendered.match(/\{\{[^}]*\}\}/g);
    if (leftover) warn(`${rel}: остались незаполненные плейсхолдеры: ${[...new Set(leftover)].join(', ')}`);
    writeFileSync(dest, rendered);
  } else {
    copyFileSync(file, dest);
  }
  count += 1;
}

writeFileSync(join(outDir, '.nojekyll'), '');               // GitHub Pages: отдавать файлы как есть
if (!isFreeSubdomain && domain !== 'example.com') writeFileSync(join(outDir, 'CNAME'), `${domain}\n`); // GitHub Pages: кастомный домен

console.log(`✔ Сайт собран в ${relative(process.cwd(), outDir) || 'dist'}/ (${count} файлов)`);
console.log(`  Организация: ${view.orgName}`);
console.log(`  Адрес сайта: ${siteUrl}/`);
for (const message of warnings) console.log(`⚠ ${message}`);
console.log('');
console.log('Дальше: разместите содержимое dist/ на хостинге по HTTPS → подтвердите домен в Search Console → укажите сайт в Play Console (см. README.md).');
