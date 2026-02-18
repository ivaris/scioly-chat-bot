import fetch from 'node-fetch';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import type { Schema } from '../../data/resource.ts';
import { computeEmbedding, cosine } from '../../common/utils.ts';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(process.env as any);
Amplify.configure(resourceConfig, libraryOptions);

const dataClient = generateClient<Schema>({
  authMode: 'iam',
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-west-2';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
const ALLOWED_PROVIDERS = ['openai', 'google', 'bedrock'] as const;

async function getConfiguredProvider(): Promise<string> {
  const fallback = OPENAI_API_KEY ? 'openai' : ((process.env.GOOGLE_API_KEY || null) ? 'google' : 'bedrock');
  const { data: configs, errors } = await dataClient.models.AppConfig.list({
    filter: { key: { eq: 'global' } },
  });
  if (errors?.length) {
    console.error('Failed to load AppConfig in chat', errors);
    return fallback;
  }
  const provider = configs?.[0]?.provider;
  if (provider && ALLOWED_PROVIDERS.includes(provider as any)) return provider;
  return fallback;
}

type ChatMessage = { role: string; content: string };

async function retrieveContext(topic: string | null, query: string | null, k = 3, provider = 'openai') {
  let candidates: any[] = [];
  
  if (topic) {
    const { data: docs, errors } = await dataClient.models.Document.list({
      filter: {
        topic: {
          eq: topic,
        },
      },
    });
    if (errors) {
      console.error('Failed to fetch documents by topic', errors);
    } else {
      candidates = docs;
    }
  } else {
    const { data: docs, errors } = await dataClient.models.Document.list();
    if (errors) {
      console.error('Failed to fetch all documents', errors);
    } else {
      candidates = docs;
    }
  }

  if (query) {
    const embCandidates = candidates.filter(d => d.embedding && d.embedding_provider === provider);
    if (embCandidates.length > 0) {
      const qEmb = await computeEmbedding((query || '').slice(0,1000), provider);
      if (qEmb) { 
        const scored = embCandidates.map(d => ({ d, score: cosine(qEmb, JSON.parse(d.embedding)) })); 
        scored.sort((a,b) => b.score - a.score); 
        return scored.slice(0,k).map(c => c.d.text); 
      }
    }
  }

  const q = (query || '').toLowerCase().split(/\W+/).filter(Boolean);
  const scored = candidates.map(d => { 
    const text = (d.text || '').toLowerCase(); 
    let score = 0; 
    for (const token of q) if (text.includes(token)) score += 1; 
    return { d, score }; 
  });
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0,k).map(s => s.d.text);
}

export const handler: Schema['chat']['functionHandler'] = async (event) => {
  try {
    const { messagesJson, topic = null } = event.arguments;
    const provider = await getConfiguredProvider();
    const messages = JSON.parse(messagesJson || '[]') as ChatMessage[];
    if (!messages || !Array.isArray(messages)) return { error: 'messages array required' };
    const ALLOWED_TOPICS = ['forensics', 'designer genes'];
    const DEFAULT_REPLY = `Please select a topic (forensics or designer genes) before chatting.`;
    if (!topic || !ALLOWED_TOPICS.includes(topic)) {
      return { reply: DEFAULT_REPLY };
    }

    const userQuery = messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n');
    const contexts = await retrieveContext(topic, userQuery, 4, provider);
    const systemContext = contexts.length ? `Context from documents:\n${contexts.join('\n---\n')}` : '';
    const payloadMessages: any[] = [];
    if (systemContext) payloadMessages.push({ role: 'system', content: systemContext });
    for (const m of messages) payloadMessages.push(m);

    if (provider === 'openai') {
      if (!OPENAI_API_KEY) return { error: 'OPENAI_API_KEY not configured on server' };
      const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: payloadMessages, temperature: 0.2 }) });
      if (!resp.ok) { const t = await resp.text(); return { error: `OpenAI error: ${t}` }; }
      const data: any = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { reply: content };
    } else if (provider === 'bedrock') {
      const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
      const prompt = `${systemContext ? `${systemContext}\n\n` : ''}${userQuery}`;
      const command = new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1200,
          temperature: 0.2,
        }),
      });
      const response = await client.send(command);
      const jsonString = new TextDecoder().decode(response.body);
      const data: any = JSON.parse(jsonString);
      const content = data?.content?.[0]?.text || data?.output_text || '';
      if (!content) return { error: `Bedrock returned empty output: ${jsonString}` };
      return { reply: content };
    }

    return { error: 'Unknown provider' };
  } catch (err: any) {
    return { error: `handler error: ${String(err)}` };
  }
};
