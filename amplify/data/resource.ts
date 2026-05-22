import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { chatFunction } from '../functions/chat/resource.ts';
import { documentsFunction } from '../functions/documents/resource.ts';

const schema = a.schema({
  Document: a
    .model({
      filename: a.string(),
      path: a.string(),
      topic: a.string(),
      // text: a.string(), // No longer storing full text in Document
      // embedding: a.string(), // No longer storing full embedding in Document
      // embedding_provider: a.string(), // No longer storing full embedding provider in Document
      chunks: a.hasMany('Chunk', 'documentID'),
    })
    .authorization((allow) => [allow.group('admin')]),

  Chunk: a
    .model({
      documentID: a.id().required(),
      chunk_idx: a.integer().required(),
      content: a.string().required(),
      size: a.integer().required(),
      embedding: a.string(), // Storing number[] as a JSON string
      embedding_provider: a.string(),
    })
    .authorization((allow) => [allow.group('admin')]),

  ChatResponse: a.customType({
    reply: a.string(),
    error: a.string(),
  }),

  TopicList: a.customType({
    topics: a.string().array(),
  }),

  OperationStatus: a.customType({
    ok: a.boolean(),
    message: a.string(),
    total: a.integer(),
  }),

  LlmProvider: a.customType({
    provider: a.string(),
  }),

  AppConfig: a
    .model({
      key: a.string().required(),
      provider: a.string().required(),
    })
    .authorization((allow) => [allow.group('admin')]),

  chat: a
    .mutation()
    .arguments({
      messagesJson: a.string().required(),
      topic: a.string(),
    })
    .returns(a.ref('ChatResponse'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function('chatFunction')),

  documentsImportTopic: a
    .mutation()
    .arguments({
      topic: a.string().required(),
    })
    .returns(a.ref('OperationStatus'))
    .authorization((allow) => [allow.group('admin')])
    .handler(a.handler.function('documentsFunction')),

  documentsPreprocess: a
    .mutation()
    .arguments({})
    .returns(a.ref('OperationStatus'))
    .authorization((allow) => [allow.group('admin')])
    .handler(a.handler.function('documentsFunction')),

  getLlmProvider: a
    .query()
    .returns(a.ref('LlmProvider'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function('documentsFunction')),

  setLlmProvider: a
    .mutation()
    .arguments({
      provider: a.string().required(),
    })
    .returns(a.ref('OperationStatus'))
    .authorization((allow) => [allow.group('admin')])
    .handler(a.handler.function('documentsFunction')),

  documentsTopics: a
    .query()
    .returns(a.ref('TopicList'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function('documentsFunction')),
}).authorization((allow) => [
  allow.resource(chatFunction).to(['query', 'mutate']),
  allow.resource(documentsFunction).to(['query', 'mutate']),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  functions: {
    chatFunction,
    documentsFunction,
  },
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
