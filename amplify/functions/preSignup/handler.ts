import type { PreSignUpTriggerHandler } from 'aws-lambda';

export const handler: PreSignUpTriggerHandler = async (event) => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') {
    return event;
  }

  throw new Error('Self sign-up is disabled. Please request an invite from an administrator.');
};
