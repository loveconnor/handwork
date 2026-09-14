import { CopilotClient } from '@github/copilot-sdk';

export class CopilotRuntime {
  constructor({ cwd = process.cwd(), approve = async () => false, question = async () => '', output = text => process.stdout.write(text), client } = {}) {
    Object.assign(this, { cwd, approve, question, output });
    this.client = client || new CopilotClient({ workingDirectory: cwd, useLoggedInUser: true });
  }
  async start() { await this.client.start(); }
  async login() {
    const auth = await this.client.getAuthStatus();
    if (!auth.isAuthenticated) throw new Error('Sign in through the official Copilot CLI using copilot login, then retry. Handwork does not collect GitHub credentials.');
    this.output('Copilot account connected through the official SDK.\n');
  }
  async models() { return this.client.listModels(); }
  async ask(prompt, { model, resume } = {}) {
    await this.login();
    const config = {
      workingDirectory: this.cwd,
      streaming: true,
      ...(model ? { model } : {}),
      onPermissionRequest: async request => ({ kind: await this.approve(request) ? 'approved' : 'denied-interactively-by-user' }),
      onUserInputRequest: async request => ({ answer: await this.question(request.question), wasFreeform: true }),
    };
    this.session = resume ? await this.client.resumeSession(resume, config) : await this.client.createSession(config);
    let streamed = false;
    let failure;
    const unsubscribe = this.session.on(event => {
      if (event.type === 'assistant.message_delta') { streamed = true; this.output(event.data.deltaContent || ''); }
      if (event.type === 'session.error') failure = new Error(event.data.message || 'Copilot session failed');
    });
    try {
      const response = await this.session.sendAndWait({ prompt }, 60 * 60 * 1000);
      if (failure) throw failure;
      if (!streamed && response?.data?.content) this.output(response.data.content);
      this.output('\n');
      return this.session.sessionId;
    } finally { unsubscribe(); await this.session.disconnect(); this.session = null; }
  }
  async interrupt() { await this.session?.abort(); }
  async stop() { await this.client.stop(); }
}
