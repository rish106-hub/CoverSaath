export class ProviderUnavailableError extends Error {
  constructor(provider, code, message) {
    super(`${provider}: ${message} No external action was attempted.`);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.code = code;
    this.statusCode = code === 'PROVIDER_AUTHORIZATION_REQUIRED' ? 403 : 503;
  }
}

export class UnconfiguredConnectorError extends ProviderUnavailableError {
  constructor(provider) {
    super(provider, 'PROVIDER_NOT_CONFIGURED', 'provider is not configured.');
    this.name = 'UnconfiguredConnectorError';
  }
}

export class UnverifiedConnectorError extends ProviderUnavailableError {
  constructor(provider) {
    super(provider, 'PROVIDER_CONTRACT_NOT_VERIFIED', 'provider contract and endpoint are not verified.');
    this.name = 'UnverifiedConnectorError';
  }
}

export class ProviderAuthorizationError extends ProviderUnavailableError {
  constructor(provider) {
    super(provider, 'PROVIDER_AUTHORIZATION_REQUIRED', 'explicit current authorization is required.');
    this.name = 'ProviderAuthorizationError';
  }
}
