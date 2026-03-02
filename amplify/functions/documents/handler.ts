import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.ts';
import { computeEmbedding, extractTextFromBuffer, extractTextFromFile } from '../../common/utils.ts';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME || null;
const S3_DOCS_PREFIX = (process.env.S3_DOCS_PREFIX || 'local_docs/').replace(/^\/+/, '');
const ALLOWED_PROVIDERS = ['openai', 'google', 'bedrock'] as const;
const DEFAULT_PROVIDER: string = OPENAI_API_KEY ? 'openai' : (GOOGLE_API_KEY ? 'google' : 'bedrock');
const DEFAULT_TOPICS = ['forensics', 'designer genes', 'scioly results'];

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

function topicToSlug(topic: string): string {
  return topic.toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function slugToTopic(slug: string): string {
  return (slug || '').replace(/_/g, ' ').trim();
}

function buildSnippet(topic: string | null, text: string, relName: string, ext: string): string {
  if (topic === 'scioly results' && ext === '.csv') {
    return buildSciolyResultsSnippet(text || '', relName);
  }
  return (text || '').slice(0, 4000);
}

function inferTopicFromRelativeName(relName: string): string | null {
  const normalized = relName.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0];
  if (!first) return null;
  return slugToTopic(first) || null;
}

async function s3BodyToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.from('');
  if (typeof body.transformToByteArray === 'function') {
    const arr = await body.transformToByteArray();
    return Buffer.from(arr);
  }
  if (typeof body.transformToString === 'function') {
    const str = await body.transformToString();
    return Buffer.from(str, 'utf8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

type ImportSource = {
  sourcePath: string;
  filename: string;
  topic: string | null;
  ext: string;
  loadText: () => Promise<string>;
};

function resolveExistingPathKey(p: string): string {
  const raw = String(p || '');
  if (!raw) return '';
  if (raw.startsWith('s3://')) return raw;
  return path.resolve(raw);
}

async function upsertDocument(
  existingByPath: Map<string, any>,
  source: ImportSource,
  provider: string,
): Promise<'added' | 'updated' | 'skipped'> {
  const text = await source.loadText();
  const snippet = buildSnippet(source.topic, text, source.filename, source.ext);
  if (!snippet.trim()) return 'skipped';
  const emb = provider ? await computeEmbedding(snippet, provider) : null;
  const existing = existingByPath.get(source.sourcePath);
  if (existing?.id) {
    const { data: doc, errors } = await dataClient.models.Document.update({
      id: existing.id,
      filename: source.filename,
      path: source.sourcePath,
      topic: source.topic,
      text: snippet,
      embedding: emb ? JSON.stringify(emb) : '',
      embedding_provider: emb ? provider : null,
    });
    if (errors || !doc) return 'skipped';
    existingByPath.set(source.sourcePath, doc);
    return 'updated';
  }

  const { data: doc, errors } = await dataClient.models.Document.create({
    filename: source.filename,
    path: source.sourcePath,
    topic: source.topic,
    text: snippet,
    embedding: emb ? JSON.stringify(emb) : '',
    embedding_provider: emb ? provider : null,
  });
  if (errors || !doc) return 'skipped';
  existingByPath.set(source.sourcePath, doc);
  return 'added';
}

async function collectLocalSources(topicFilter: string | null): Promise<ImportSource[]> {
  const sources: ImportSource[] = [];
  const rootDir = topicFilter
    ? path.join(LOCAL_DOCS_DIR, topicToSlug(topicFilter))
    : LOCAL_DOCS_DIR;
  if (!fs.existsSync(rootDir)) return sources;
  const files = await walkDir(rootDir);
  for (const full of files) {
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    const relName = path.relative(LOCAL_DOCS_DIR, full);
    const ext = path.extname(full).toLowerCase();
    const topic = topicFilter || inferTopicFromRelativeName(relName);
    sources.push({
      sourcePath: path.resolve(full),
      filename: relName,
      topic,
      ext,
      loadText: async () => extractTextFromFile(full),
    });
  }
  return sources;
}

async function collectS3Sources(topicFilter: string | null): Promise<ImportSource[]> {
  const sources: ImportSource[] = [];
  if (!STORAGE_BUCKET_NAME) return sources;

  const client = new S3Client({ region: AWS_REGION });
  const prefix = topicFilter
    ? `${S3_DOCS_PREFIX}${topicToSlug(topicFilter)}/`
    : S3_DOCS_PREFIX;
  let continuationToken: string | undefined;

  do {
    const listResp = await client.send(new ListObjectsV2Command({
      Bucket: STORAGE_BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = listResp.Contents || [];
    for (const obj of objects) {
      const key = obj.Key || '';
      if (!key || key.endsWith('/')) continue;
      const relName = key.startsWith(S3_DOCS_PREFIX) ? key.slice(S3_DOCS_PREFIX.length) : key;
      const ext = path.extname(relName).toLowerCase();
      const topic = topicFilter || inferTopicFromRelativeName(relName);
      const sourcePath = `s3://${STORAGE_BUCKET_NAME}/${key}`;
      sources.push({
        sourcePath,
        filename: relName,
        topic,
        ext,
        loadText: async () => {
          const objResp = await client.send(new GetObjectCommand({
            Bucket: STORAGE_BUCKET_NAME,
            Key: key,
          }));
          const buffer = await s3BodyToBuffer(objResp.Body);
          return extractTextFromBuffer(buffer, ext);
        },
      });
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
  } while (continuationToken);

  return sources;
}

async function ensureS3TopicFolders() {
  if (!STORAGE_BUCKET_NAME) return;
  const client = new S3Client({ region: AWS_REGION });
  for (const topic of DEFAULT_TOPICS) {
    const key = `${S3_DOCS_PREFIX}${topicToSlug(topic)}/.keep`;
    try {
      await client.send(new PutObjectCommand({
        Bucket: STORAGE_BUCKET_NAME,
        Key: key,
        Body: '',
      }));
    } catch (err) {
      console.error(`[documents] failed to ensure S3 folder key ${key}`, err);
    }
  }
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
  console.log(`[documents] importTopic start topic="${topic}" provider="${provider}"`);
  await ensureS3TopicFolders();
  const localSources = await collectLocalSources(topic);
  const s3Sources = await collectS3Sources(topic);
  const sources = [...localSources, ...s3Sources];
  if (!sources.length) {
    const slug = topicToSlug(topic);
    return {
      ok: false,
      message: `No files found for topic "${topic}". Checked local_docs/${slug} and s3://${STORAGE_BUCKET_NAME || '<unset-bucket>'}/${S3_DOCS_PREFIX}${slug}/`,
      total: 0,
    };
  }

  const { data: existingDocs } = await dataClient.models.Document.list();
  const existingByPath = new Map(
    existingDocs
      .map((d: any) => [resolveExistingPathKey(d.path), d] as const)
      .filter(([k]) => Boolean(k)),
  );

  let added = 0;
  let updated = 0;
  for (const source of sources) {
    try {
      const result = await upsertDocument(existingByPath, source, provider);
      if (result === 'updated') {
        updated += 1;
      } else if (result === 'added') {
        added += 1;
      }
    } catch (err) {
      console.error(`Failed to import ${source.sourcePath}`, err);
    }
  }

  console.log(`[documents] importTopic done topic="${topic}" added=${added} updated=${updated}`);
  return { ok: true, message: `Imported ${added} files, updated ${updated} files`, total: existingDocs.length + added };
}

async function preprocess(provider: string) {
  console.log(`[documents] preprocess start provider="${provider}"`);
  await ensureS3TopicFolders();
  const { data: existingDocs } = await dataClient.models.Document.list();
  const existingByPath = new Map(
    existingDocs
      .map((d: any) => [resolveExistingPathKey(d.path), d] as const)
      .filter(([k]) => Boolean(k)),
  );
  const sources = [...await collectLocalSources(null), ...await collectS3Sources(null)];

  let added = 0;
  let updated = 0;
  for (const source of sources) {
    try {
      const result = await upsertDocument(existingByPath, source, provider);
      if (result === 'updated') {
        updated += 1;
      } else if (result === 'added') {
        added += 1;
      }
    } catch (err) {
      console.error(`Failed to preprocess ${source.sourcePath}`, err);
    }
  }

  console.log(`[documents] preprocess done added=${added} updated=${updated}`);
  return { ok: true, message: `Preprocessed ${added} files, updated ${updated} files`, total: existingDocs.length + added };
}

async function getTopics() {
  const predefined = DEFAULT_TOPICS;
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
