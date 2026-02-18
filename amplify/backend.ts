import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { chatFunction } from './functions/chat/resource';
import { documentsFunction } from './functions/documents/resource';

defineBackend({
  auth,
  data,
  chatFunction,
  documentsFunction,
});
