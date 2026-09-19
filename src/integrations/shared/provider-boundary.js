import {
  ProviderAuthorizationError,
  UnconfiguredConnectorError,
  UnverifiedConnectorError,
} from './provider-errors.js';

const present = value => typeof value === 'string' && value.trim().length > 0;

export function createProviderBoundary({ provider, env, requiredSettings, role }) {
  const configured = requiredSettings.every(name => present(env?.[name]));
  const status = configured ? 'configured_not_verified' : 'not_configured';

  return {
    capability() {
      return { status, role };
    },
    health() {
      return {
        provider,
        status,
        networkAttempted: false,
        contractVerified: false,
      };
    },
    refuse({ authorizationRequired = true, authorization } = {}) {
      if (!configured) throw new UnconfiguredConnectorError(provider);
      if (authorizationRequired && authorization !== true && authorization?.authorized !== true) {
        throw new ProviderAuthorizationError(provider);
      }
      throw new UnverifiedConnectorError(provider);
    },
  };
}
