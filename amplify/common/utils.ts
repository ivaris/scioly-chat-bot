import fetch from 'node-fetch';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;

// Sanitize text by removing null bytes and invalid UTF-8 sequences
export function sanitizeText(text: string): string {
  if (!text) return text;
  // Remove null bytes and other invalid UTF-8 characters
  return text.replace(/\0/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ' ').trim();
}

export async function extractTextFromBuffer(buffer: Buffer, ext: string): Promise<string> {
  const normalizedExt = (ext || '').toLowerCase();
  if (normalizedExt === '.pdf') {
    const data: any = await pdfParse(buffer);
    return sanitizeText(data.text || '');
  }
  if (normalizedExt === '.docx' || normalizedExt === '.doc') {
    try {
      const res: any = await mammoth.extractRawText({ buffer });
      return sanitizeText(res.value || '');
    } catch {
      return '';
    }
  }
  return sanitizeText(buffer.toString('utf8'));
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const b = await fs.readFile(filePath);
  return extractTextFromBuffer(b, ext);
}

export async function computeEmbedding(text: string, provider = 'openai'): Promise<number[] | null> {
  if (provider === 'openai') {
    if (!OPENAI_API_KEY) return null;
    try {
      const url = 'https://api.openai.com/v1/embeddings';
      const body = { input: text, model: 'text-embedding-3-small' };
      const r: any = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body) });
      if (!r.ok) return null;
      const data = await r.json();
      const emb = data.data && data.data[0] && data.data[0].embedding;
      return emb || null;
    } catch { return null; }
  }
  if (provider === 'google') {
    if (!GOOGLE_API_KEY) return null;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta2/models/textembedding-gecko-001:embed?key=${GOOGLE_API_KEY}`;
      const body = { input: text };
      const r: any = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return null;
      const data = await r.json();
      const emb = data && (data.embeddings && data.embeddings[0] && data.embeddings[0].embedding) || (data.embedding && data.embedding[0]);
      return emb || null;
    } catch { return null; }
  }
  return null;
}

export function cosine(a: number[] | null, b: number[] | null) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}
