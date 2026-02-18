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

async function importTopic(topic: string, provider: string | null) {
  const slug = topic.toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const topicDir = path.join(LOCAL_DOCS_DIR, slug);
  if (!fs.existsSync(topicDir)) {
    return { ok: false, message: 'topic directory not found', total: 0 };
  }

  const files = await walkDir(topicDir);
  const { data: existingDocs } = await dataClient.models.Document.list();
  const seenPaths = new Set(existingDocs.map((d: any) => path.resolve(d.path)));

  let added = 0;
  for (const full of files) {
    const resolvedFull = path.resolve(full);
    if (seenPaths.has(resolvedFull)) continue;
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;

    try {
      const text = await extractTextFromFile(full);
      const snippet = (text || '').slice(0, 4000);
      const emb = provider ? await computeEmbedding(snippet, provider) : null;
      const relName = path.relative(LOCAL_DOCS_DIR, full);
      const { data: doc, errors } = await dataClient.models.Document.create({
        filename: relName,
        path: full,
        topic,
        text: snippet,
        embedding: emb ? JSON.stringify(emb) : '',
        embedding_provider: emb ? provider : null,
      });

      if (errors || !doc) continue;
      seenPaths.add(resolvedFull);
      added += 1;
    } catch (err) {
      console.error(`Failed to import ${full}`, err);
    }
  }

  return { ok: true, message: `Imported ${added} files`, total: existingDocs.length + added };
}

async function preprocess(provider: string | null) {
  const { data: existingDocs } = await dataClient.models.Document.list();
  const seenPaths = new Set(existingDocs.map((d: any) => path.resolve(d.path)));

  let added = 0;
  if (fs.existsSync(LOCAL_DOCS_DIR)) {
    const files = await walkDir(LOCAL_DOCS_DIR);
    for (const full of files) {
      const resolvedFull = path.resolve(full);
      if (seenPaths.has(resolvedFull)) continue;

      try {
        const text = await extractTextFromFile(full);
        const snippet = (text || '').slice(0, 4000);
        const emb = provider ? await computeEmbedding(snippet, provider) : null;

        const { data: doc, errors } = await dataClient.models.Document.create({
          filename: path.relative(LOCAL_DOCS_DIR, full),
          path: full,
          topic: null,
          text: snippet,
          embedding: emb ? JSON.stringify(emb) : '',
          embedding_provider: emb ? provider : null,
        });

        if (errors || !doc) continue;
        seenPaths.add(resolvedFull);
        added += 1;
      } catch (err) {
        console.error(`Failed to preprocess ${full}`, err);
      }
    }
  }

  return { ok: true, message: `Preprocessed ${added} files`, total: existingDocs.length + added };
}

async function getTopics() {
  const predefined = ['forensics', 'designer genes'];
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
  const provider = args.provider || (OPENAI_API_KEY ? 'openai' : (GOOGLE_API_KEY ? 'google' : null));

  if (field === 'documentsTopics') return await getTopics();
  if (field === 'documentsImportTopic') return await importTopic(args.topic, provider);
  if (field === 'documentsPreprocess') return await preprocess(provider);

  return { ok: false, message: `Unsupported field: ${field}`, total: 0 };
};
