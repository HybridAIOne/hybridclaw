import type { DoctorCheck } from '../types.js';
import { checkChannels } from './channels.js';
import { checkConfig } from './config.js';
import { checkCredentials } from './credentials.js';
import { checkDatabase } from './database.js';
import { checkDisk } from './disk.js';
import { checkDocker } from './docker.js';
import { checkGateway } from './gateway.js';
import { checkLocalBackendsCategory } from './local-backends.js';
import { checkProviders } from './providers.js';
import { checkRuntime } from './runtime.js';
import { checkSecurity } from './security.js';
import { checkSkills } from './skills.js';

export function doctorChecks(): DoctorCheck[] {
  return [
    {
      category: 'runtime',
      label: 'Runtime',
      run: checkRuntime,
    },
    {
      category: 'gateway',
      label: 'Gateway',
      run: checkGateway,
    },
    {
      category: 'config',
      label: 'Config',
      run: checkConfig,
    },
    {
      category: 'credentials',
      label: 'Credentials',
      run: checkCredentials,
    },
    {
      category: 'database',
      label: 'Database',
      run: checkDatabase,
    },
    {
      category: 'providers',
      label: 'Providers',
      run: checkProviders,
    },
    {
      category: 'local-backends',
      label: 'Local backends',
      run: checkLocalBackendsCategory,
    },
    {
      category: 'docker',
      label: 'Docker',
      run: checkDocker,
    },
    {
      category: 'channels',
      label: 'Channels',
      run: checkChannels,
    },
    {
      category: 'skills',
      label: 'Skills',
      run: checkSkills,
    },
    {
      category: 'security',
      label: 'Security',
      run: checkSecurity,
    },
    {
      category: 'disk',
      label: 'Disk',
      run: checkDisk,
    },
  ];
}
