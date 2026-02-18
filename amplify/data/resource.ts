import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { chatFunction } from '../functions/chat/resource.ts';
import { documentsFunction } from '../functions/documents/resource.ts';

const schema = a.schema({
  Document: a
    .model({
      filename: a.string(),
      path: a.string(),
      topic: a.string(),
      text: a.string(),
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

  chat: a
    .mutation()
    .arguments({
      messagesJson: a.string().required(),
      provider: a.string(),
      topic: a.string(),
    })
    .returns(a.ref('ChatResponse'))
    .authorization((allow) => [allow.authenticated(), allow.guest()])
    .handler(a.handler.function('chatFunction')),

  documentsImportTopic: a
    .mutation()
    .arguments({
      topic: a.string().required(),
      provider: a.string(),
    })
    .returns(a.ref('OperationStatus'))
    .authorization((allow) => [allow.authenticated(), allow.guest()])
    .handler(a.handler.function('documentsFunction')),

  documentsPreprocess: a
    .mutation()
    .arguments({
      provider: a.string(),
    })
    .returns(a.ref('OperationStatus'))
    .authorization((allow) => [allow.authenticated(), allow.guest()])
    .handler(a.handler.function('documentsFunction')),

  documentsTopics: a
    .query()
    .returns(a.ref('TopicList'))
    .authorization((allow) => [allow.authenticated(), allow.guest()])
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
    defaultAuthorizationMode: 'identityPool',
  },
});
