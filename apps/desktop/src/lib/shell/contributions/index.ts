/**
 * Every contribution the app ships, in registration order. All are enabled in this build; the
 * left panel's foot names them. Enabling and disabling is the package-boundary build's.
 */
import type { Contribution } from '../lenses';
import { core } from './core';

export const enabled: readonly Contribution[] = [core];
