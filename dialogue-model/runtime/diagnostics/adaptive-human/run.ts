import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runOffline} from './offline.ts';

export async function main(args = process.argv.slice(2)) {
  const {values} = parseArgs({args, options: {out: {type: 'string'}, chrome: {type: 'string'}, cdp: {type: 'string'}, turns: {type: 'string'},
    mode: {type: 'string', default: 'offline'}, app: {type: 'string'}, 'persona-seed': {type: 'string', default: '20261027'}, 'before-turn-module': {type: 'string'},
    'technical-trial': {type: 'boolean'}, 'trial-version': {type: 'string'}, strategy: {type: 'string'}, 'jev-actions': {type: 'string'}}});
  if (!values.out || !['offline', 'live'].includes(values.mode!)) throw new Error('invalid_adaptive_human_arguments');
  const shared = values.turns === undefined ? {} : {maxTurns: Number(values.turns)};
  if (values.mode === 'offline') return runOffline({directory: resolve(values.out), chrome: values.chrome, cdpOrigin: values.cdp,
    personaSeed: Number(values['persona-seed']), technicalTrial: values['trial-version'] === 'adaptive_repair_v2' ? 'adaptive_repair_v2' as const : values['technical-trial'] === true,
    ...(values.strategy === 'bypass-enabled' ? {strategy: 'bypass-enabled' as const} : {}),
    ...(values['jev-actions'] ? {jevActions: values['jev-actions'].split(',')} : {}), ...shared});
  if (!values.app || !values.cdp) throw new Error('live_requires_app_and_cdp');
  // Only the parent executes this branch, with its existing guard imported before this module.
  const [{loadConfig}, {liveHuman}, {driveParticipant}, {createPersona}] = await Promise.all([
    import('../../config.mjs'), import('./live.ts'), import('./harness.ts'), import('./simulator.ts')]);
  const config = loadConfig(process.env);
  if (config.provider !== 'cloudflare' || config.purpose !== 'dialogue_turn') throw new Error('live_requires_research_worker');
  const beforeSimulatorTurn = values['before-turn-module'] ?
    (await import(pathToFileURL(resolve(values['before-turn-module'])).href)).default : undefined;
  if (beforeSimulatorTurn !== undefined && typeof beforeSimulatorTurn !== 'function') throw new Error('invalid_before_turn_hook');
  return driveParticipant({appOrigin: values.app, cdpOrigin: values.cdp, outputDirectory: resolve(values.out),
    persona: createPersona(Number(values['persona-seed'])), simulator: liveHuman(config), beforeSimulatorTurn, ...shared});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('adaptive_human_offline_failed'); process.exitCode = 1;
  });
}
