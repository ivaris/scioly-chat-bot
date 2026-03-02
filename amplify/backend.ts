import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.ts';
import { data } from './data/resource.ts';
import { chatFunction } from './functions/chat/resource.ts';
import { documentsFunction } from './functions/documents/resource.ts';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

const backend = defineBackend({
  auth,
  data,
  chatFunction,
  documentsFunction,
});

// addEnvironment exists on Lambda Function implementation used by Amplify.
(backend.documentsFunction.resources.lambda as any).addEnvironment(
  'STORAGE_BUCKET_NAME',
  'scioly-content',
);
(backend.documentsFunction.resources.lambda as any).addEnvironment(
  'S3_DOCS_PREFIX',
  'local_docs/',
);

backend.documentsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: ['arn:aws:s3:::scioly-content'],
  }),
);

backend.documentsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: ['arn:aws:s3:::scioly-content/local_docs/*'],
  }),
);

backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: ['*'],
  }),
);
