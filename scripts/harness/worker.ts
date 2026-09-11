import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileRunCheckpointStore } from '../../packages/core/src/infrastructure/RunCheckpointStore.js';
import { writeJson } from './state.js';

// This entry point and persistence code run from the pinned stable snapshot.
// Only the business Harness is dynamically loaded from the candidate source tree.
const [versionRoot, taskFile, runDirectory] = process.argv.slice(2);
const task = JSON.parse(await readFile(taskFile, 'utf8'));
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n');
try {
  const { AgentBuilder } = await import(pathToFileURL(join(versionRoot, 'packages/core/src/domain/agent/AgentBuilder.ts')).href);
  const builder = new AgentBuilder()
    .withWorkingDirectory(task.workingDirectory)
    .withModel(process.env.AGENT_PROVIDER || 'openai', {
      apiKey: process.env.AGENT_API_KEY || '',
      modelId: process.env.AGENT_MODEL || '',
      baseUrl: process.env.AGENT_BASE_URL,
    })
    .withRunCheckpointStore(new FileRunCheckpointStore(join(runDirectory, 'checkpoint.json')))
    .withMaxIterations(task.maxIterations)
    .withSemanticSkillMatching(false);
  const agent = await builder.build();
  process.on('SIGTERM', () => { agent.abort(); process.exit(143); });
  let completed = false, failed = false;
  for await (const event of agent.run(task.input, task.sessionId)) {
    emit(event);
    if (event.type === 'error' || event.type === 'turn_aborted') failed = true;
    if (event.type === 'done') {
      completed = true;
      const cp = await new FileRunCheckpointStore(join(runDirectory, 'checkpoint.json')).load();
      if (cp?.phase !== 'completed') failed = true; // max iterations is not success
      if (!failed) await writeJson(join(runDirectory, 'result.json'), { finalText: event.finalText });
    }
  }
  if (!completed || failed) process.exitCode = 2;
} catch (error) {
  emit({ type: 'harness_fault', message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
}
