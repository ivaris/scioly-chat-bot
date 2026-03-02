# Code Structure And Flow

## High-Level Structure
- `amplify/backend.ts`: wires all backend resources (auth, data, lambdas, IAM policy).
- `amplify/auth/resource.ts`: Cognito auth config + pre-signup trigger (invite-only).
- `amplify/data/resource.ts`: AppSync schema (models, queries, mutations, auth rules).
- `amplify/functions/chat/*`: chat lambda (LLM routing, image tool, guardrails).
- `amplify/functions/documents/*`: docs/topic/provider config mutations.
- `amplify/functions/preSignup/*`: blocks public signup.
- `client/src/main.jsx`: bootstraps React + `Amplify.configure(...)`.
- `client/src/App.jsx`: auth UI, role-based UI, admin tools modal, chat UI.
- `client/src/styles.css`: styling.

## Backend Flow
```text
User (browser)
  -> AppSync GraphQL (Data API)
    -> custom mutation/query resolver
      -> Lambda function
        -> optional external LLM/API calls
      -> return payload to AppSync
  -> response back to browser
```

## Auth/Role Flow
```text
Sign in (Cognito User Pool)
  -> JWT includes groups (e.g., admin)
  -> App UI checks groups via fetchAuthSession()
  -> schema auth enforces:
     - authenticated: chat/topics/provider-read
     - admin group: provider-set, preprocess/import
```

## Chat Flow
```text
App.jsx send()
  -> GraphQL mutation chat(messagesJson, topic)
    -> chat handler:
       1) resolve configured provider from AppConfig
       2) validate topic
       3) detect image intent
          - if image request:
            - guardrails (safe + topic-relevant)
            - return plain-text links
       4) else retrieve context from Document model
       5) call selected LLM (OpenAI or Bedrock)
       6) return reply/error
```

## Admin Tools Flow
```text
Admin opens modal
  -> Save Provider
     -> setLlmProvider mutation
     -> documents handler writes AppConfig.provider
  -> Preprocess Topic
     -> documentsImportTopic(topic)
     -> documentsPreprocess()
     -> updates Document model for retrieval
```

## Invite-Only User Creation
```text
Public signup attempt
  -> preSignUp trigger
  -> reject unless trigger source is AdminCreateUser

Admin creates user in Cognito
  -> allowed
  -> invited user signs in
  -> if NEW_PASSWORD_REQUIRED: UI handles confirmSignIn(new password)
```

## Data Model Snapshot
- `Document` (admin-managed indexed docs/embeddings)
- `AppConfig` (`key=global`, provider setting)
- custom return types:
  - `ChatResponse`
  - `OperationStatus`
  - `TopicList`
  - `LlmProvider`
