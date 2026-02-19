import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.ts';
import { data } from './data/resource.ts';
import { chatFunction } from './functions/chat/resource.ts';
import { documentsFunction } from './functions/documents/resource.ts';
import { preSignupFunction } from './functions/preSignup/resource.ts';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

const backend = defineBackend({
  auth,
  data,
  chatFunction,
  documentsFunction,
  preSignupFunction,
});

backend.chatFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: ['*'],
  }),
);
