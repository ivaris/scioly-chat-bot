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
    const { messagesJson, provider = null, topic = null } = event.arguments;
    const messages = JSON.parse(messagesJson || '[]') as ChatMessage[];
    if (!messages || !Array.isArray(messages)) return { error: 'messages array required' };
    const ALLOWED_TOPICS = ['forensics', 'designer genes'];
    const DEFAULT_REPLY = `Please select a provider (openai or google) and a topic (forensics or designer genes) before chatting.`;
    if (!provider || !['openai', 'google', 'bedrock'].includes(provider) || !topic || !ALLOWED_TOPICS.includes(topic)) {
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
      const client = new BedrockRuntimeClient({ region: 'us-east-1' });
      const modelId = 'anthropic.claude-v2';
      const prompt = `\n\nHuman: ${systemContext}\n\n${userQuery}\n\nAssistant:`;
      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          prompt,
          max_tokens_to_sample: 2000,
          temperature: 0.2,
        }),
      });
      const response = await client.send(command);
      const jsonString = new TextDecoder().decode(response.body);
      const data = JSON.parse(jsonString);
      const content = data.completion;
      return { reply: content };
    }

    return { error: 'Unknown provider' };
  } catch (err: any) {
    return { error: `handler error: ${String(err)}` };
  }
};
