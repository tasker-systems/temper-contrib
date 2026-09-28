/**
 * Every contribution the app ships, in registration order. All are enabled in this build — core,
 * and temper-workflows as the default-enabled workflow plugin — and the left panel's foot names
 * them. Enabling and disabling is the package-boundary build's.
 */
import type { Contribution } from '../lenses';
import { core } from './core';
import { temperWorkflows } from './temper-workflows';

export const enabled: readonly Contribution[] = [core, temperWorkflows];
