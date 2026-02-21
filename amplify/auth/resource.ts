import { defineAuth } from '@aws-amplify/backend';
import { preSignupFunction } from '../functions/preSignup/resource.ts';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  triggers: {
    preSignUp: preSignupFunction,
  },
});
