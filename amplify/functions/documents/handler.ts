import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.ts';
import { computeEmbedding, extractTextFromFile } from '../../common/utils.ts';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(process.env as any);
Amplify.configure(resourceConfig, libraryOptions);

const dataClient = generateClient<Schema>({
  authMode: 'iam',
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_DOCS_DIR = path.resolve(__dirname, '..', '..', '..', 'local_docs');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const ALLOWED_PROVIDERS = ['openai', 'google', 'bedrock'] as const;
const DEFAULT_PROVIDER: string = OPENAI_API_KEY ? 'openai' : (GOOGLE_API_KEY ? 'google' : 'bedrock');

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeSchoolTeamLabel(school: string, team: string): string {
  const schoolName = (school || '').trim();
  const rawTeam = (team || '').trim();
  if (!schoolName) return '';
  if (!rawTeam) return `${schoolName} Team Unspecified`;
  if (/^team\s+/i.test(rawTeam)) return `${schoolName} ${rawTeam}`;
  return `${schoolName} Team ${rawTeam}`;
}

function parseTournamentMeta(filename: string): { date: string; tournament: string } {
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  if (!m) {
    return { date: 'unknown-date', tournament: base };
  }
  const [, date, rawTournament] = m;
  const tournament = rawTournament
    .replace(/_c$/i, '')
    .replace(/_+/g, ' ')
    .trim();
  return { date, tournament };
}

function buildSciolyResultsSnippet(rawText: string, filename: string): string {
  const lines = (rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return rawText.slice(0, 4000);

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idxSchool = headers.indexOf('school');
  const idxTeam = headers.indexOf('team');
  const idxRank = headers.indexOf('rank');
  const idxTotal = headers.indexOf('total');
  const idxState = headers.indexOf('state');
  const idxTrack = headers.indexOf('track');
  if (idxSchool < 0 || idxRank < 0 || idxTotal < 0) return rawText.slice(0, 4000);

  const { date, tournament } = parseTournamentMeta(filename);
  const normalizedLines: string[] = [
    `Scioly results extracted from ${path.basename(filename)}.`,
    `Treat each team label as distinct (example: Team A vs Team B).`,
  ];

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const school = cols[idxSchool] || '';
    const team = idxTeam >= 0 ? (cols[idxTeam] || '') : '';
    const rank = cols[idxRank] || '';
    const total = cols[idxTotal] || '';
    const state = idxState >= 0 ? (cols[idxState] || '') : '';
    const track = idxTrack >= 0 ? (cols[idxTrack] || '') : '';
    const teamLabel = normalizeSchoolTeamLabel(school, team);
    if (!teamLabel || !rank || !total) continue;

    normalizedLines.push(
      `${date} | ${tournament} | ${teamLabel} | rank=${rank} | total=${total}${state ? ` | state=${state}` : ''}${track ? ` | track=${track}` : ''}`,
    );
  }

  // Keep import payload compact while preserving many teams per tournament file.
  return normalizedLines.join('\n').slice(0, 24000);
}

async function walkDir(dir: string) {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const resPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkDir(resPath);
      results.push(...sub);
    } else if (ent.isFile()) {
      results.push(resPath);
    }
  }
  return results;
}

async function getConfiguredProvider(): Promise<string> {
  const { data: configs, errors } = await dataClient.models.AppConfig.list({
    filter: { key: { eq: 'global' } },
  });
  if (errors?.length) {
    console.error('Failed to load AppConfig', errors);
    return DEFAULT_PROVIDER;
  }
  const provider = configs?.[0]?.provider;
  if (provider && ALLOWED_PROVIDERS.includes(provider as any)) return provider;
  return DEFAULT_PROVIDER;
}

async function setConfiguredProvider(provider: string) {
  if (!ALLOWED_PROVIDERS.includes(provider as any)) {
    return { ok: false, message: `Invalid provider: ${provider}`, total: 0 };
  }
  const { data: configs, errors } = await dataClient.models.AppConfig.list({
    filter: { key: { eq: 'global' } },
  });
  if (errors?.length) {
    console.error('Failed to list AppConfig', errors);
    return { ok: false, message: 'Failed to load config', total: 0 };
  }

  const existing = configs?.[0];
  if (existing?.id) {
    const { errors: updateErrors } = await dataClient.models.AppConfig.update({
      id: existing.id,
      key: 'global',
      provider,
    });
    if (updateErrors?.length) {
      console.error('Failed to update AppConfig', updateErrors);
      return { ok: false, message: 'Failed to update provider', total: 0 };
    }
  } else {
    const { errors: createErrors } = await dataClient.models.AppConfig.create({
      key: 'global',
      provider,
    });
    if (createErrors?.length) {
      console.error('Failed to create AppConfig', createErrors);
      return { ok: false, message: 'Failed to save provider', total: 0 };
    }
  }

  return { ok: true, message: `Provider set to ${provider}`, total: 1 };
}

async function importTopic(topic: string, provider: string) {
  const slug = topic.toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const topicDir = path.join(LOCAL_DOCS_DIR, slug);
  if (!fs.existsSync(topicDir)) {
    return { ok: false, message: 'topic directory not found', total: 0 };
  }

  const files = await walkDir(topicDir);
  const { data: existingDocs } = await dataClient.models.Document.list();
  const existingByPath = new Map(existingDocs.map((d: any) => [path.resolve(d.path), d]));

  let added = 0;
  let updated = 0;
  for (const full of files) {
    const resolvedFull = path.resolve(full);
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;

    try {
      const relName = path.relative(LOCAL_DOCS_DIR, full);
      const text = await extractTextFromFile(full);
      const ext = path.extname(full).toLowerCase();
      const snippet = topic === 'scioly results' && ext === '.csv'
        ? buildSciolyResultsSnippet(text || '', relName)
        : (text || '').slice(0, 4000);
      const emb = provider ? await computeEmbedding(snippet, provider) : null;
      const existing = existingByPath.get(resolvedFull);
      if (existing?.id) {
        const { data: doc, errors } = await dataClient.models.Document.update({
          id: existing.id,
          filename: relName,
          path: full,
          topic,
          text: snippet,
          embedding: emb ? JSON.stringify(emb) : '',
          embedding_provider: emb ? provider : null,
        });
        if (errors || !doc) continue;
        existingByPath.set(resolvedFull, doc);
        updated += 1;
      } else {
        const { data: doc, errors } = await dataClient.models.Document.create({
          filename: relName,
          path: full,
          topic,
          text: snippet,
          embedding: emb ? JSON.stringify(emb) : '',
          embedding_provider: emb ? provider : null,
        });
        if (errors || !doc) continue;
        existingByPath.set(resolvedFull, doc);
        added += 1;
      }
    } catch (err) {
      console.error(`Failed to import ${full}`, err);
    }
  }

  return { ok: true, message: `Imported ${added} files, updated ${updated} files`, total: existingDocs.length + added };
}

async function preprocess(provider: string) {
  const { data: existingDocs } = await dataClient.models.Document.list();
  const existingByPath = new Map(existingDocs.map((d: any) => [path.resolve(d.path), d]));

  let added = 0;
  let updated = 0;
  if (fs.existsSync(LOCAL_DOCS_DIR)) {
    const files = await walkDir(LOCAL_DOCS_DIR);
    for (const full of files) {
      const resolvedFull = path.resolve(full);

      try {
        const relName = path.relative(LOCAL_DOCS_DIR, full);
        const text = await extractTextFromFile(full);
        const ext = path.extname(full).toLowerCase();
        const isSciolyResultsCsv = relName.startsWith(`scioly_results${path.sep}`) && ext === '.csv';
        const snippet = isSciolyResultsCsv
          ? buildSciolyResultsSnippet(text || '', relName)
          : (text || '').slice(0, 4000);
        const emb = provider ? await computeEmbedding(snippet, provider) : null;
        const existing = existingByPath.get(resolvedFull);
        if (existing?.id) {
          const { data: doc, errors } = await dataClient.models.Document.update({
            id: existing.id,
            filename: relName,
            path: full,
            topic: existing.topic || (isSciolyResultsCsv ? 'scioly results' : null),
            text: snippet,
            embedding: emb ? JSON.stringify(emb) : '',
            embedding_provider: emb ? provider : null,
          });
          if (errors || !doc) continue;
          existingByPath.set(resolvedFull, doc);
          updated += 1;
        } else {
          const { data: doc, errors } = await dataClient.models.Document.create({
            filename: relName,
            path: full,
            topic: isSciolyResultsCsv ? 'scioly results' : null,
            text: snippet,
            embedding: emb ? JSON.stringify(emb) : '',
            embedding_provider: emb ? provider : null,
          });
          if (errors || !doc) continue;
          existingByPath.set(resolvedFull, doc);
          added += 1;
        }
      } catch (err) {
        console.error(`Failed to preprocess ${full}`, err);
      }
    }
  }

  return { ok: true, message: `Preprocessed ${added} files, updated ${updated} files`, total: existingDocs.length + added };
}

async function getTopics() {
  const predefined = ['forensics', 'designer genes', 'scioly results'];
  const { data: docs, errors } = await dataClient.models.Document.list();

  if (errors) {
    console.error('Failed to get topics', errors);
    return { topics: predefined };
  }

  const discovered = Array.from(new Set(docs.map((d: any) => d.topic).filter(Boolean as any)));
  return { topics: Array.from(new Set([...predefined, ...discovered])) };
}

export const handler = async (event: any) => {
  const field = event?.info?.fieldName;
  const args = event?.arguments || {};
  const provider = await getConfiguredProvider();

  if (field === 'getLlmProvider') return { provider };
  if (field === 'setLlmProvider') return await setConfiguredProvider(args.provider);
  if (field === 'documentsTopics') return await getTopics();
  if (field === 'documentsImportTopic') return await importTopic(args.topic, provider);
  if (field === 'documentsPreprocess') return await preprocess(provider);

  return { ok: false, message: `Unsupported field: ${field}`, total: 0 };
};
