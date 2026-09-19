/** Compatibility facade. Provider implementations live under src/integrations. */
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
  UnconfiguredConnectorError,
} from '../integrations/index.js';

export { UnconfiguredConnectorError } from '../integrations/index.js';

export function capabilities(env = process.env) {
  return {
    models: { status: 'not_configured', role: 'Bounded extraction and draft generation; never permissions or claim decisions.' },
    sarvamOcr: createSarvamOcrProvider({ env }).capabilities(),
    gnani: createGnaniVoiceProvider({ env }).capabilities(),
    pineLabs: createPineLabsPaymentProvider({ env }).capabilities(),
    email: createEmailProvider({ env }).capabilities(),
    documentIntake: { status: 'manual_upload_only', role: 'The user uploads documents directly. HRMS connectivity is on hold.' },
    delhivery: { status: 'out_of_scope', role: 'No physical-document need demonstrated.' },
  };
}

export function createAdapters({ env = process.env } = {}) {
  const voiceProvider = createGnaniVoiceProvider({ env });
  const paymentProvider = createPineLabsPaymentProvider({ env });
  const ocrProvider = createSarvamOcrProvider({ env });
  const emailProvider = createEmailProvider({ env });

  return {
    voice: {
      transcribe(audio, permission) { return voiceProvider.transcribe({ audio, authorization: permission }); },
      synthesize(text, permission) { return voiceProvider.synthesize({ text, authorization: permission }); },
      transfer(minimalContext, permission) { return voiceProvider.transfer({ minimalContext, authorization: permission }); },
    },
    payment: {
      createCheckout(approvedPurchase, permission) { return paymentProvider.createHostedCheckout({ approvedPurchase, authorization: permission }); },
      reconcile(verifiedWebhook, permission) { return paymentProvider.reconcile({ verifiedWebhook, authorization: permission }); },
    },
    ocr: {
      createJob(document, permission) { return ocrProvider.createJob({ document, authorization: permission }); },
      getJob(providerJobId, permission) { return ocrProvider.getJob({ providerJobId, authorization: permission }); },
    },
    institutional: {
      send(approvedMinimalQuestion, permission) { return emailProvider.sendApprovedMessage({ approvedMinimalQuestion, authorization: permission }); },
    },
  };
}

// Compatibility exports are lazy. New code should inject createAdapters({ env }).
export const voiceAdapter = {
  transcribe(audio, permission) { return createAdapters().voice.transcribe(audio, permission); },
  synthesize(text, permission) { return createAdapters().voice.synthesize(text, permission); },
  transfer(minimalContext, permission) { return createAdapters().voice.transfer(minimalContext, permission); },
};
export const paymentAdapter = {
  createCheckout(approvedPurchase, permission) { return createAdapters().payment.createCheckout(approvedPurchase, permission); },
  reconcile(verifiedWebhook, permission) { return createAdapters().payment.reconcile(verifiedWebhook, permission); },
};
export const ocrAdapter = {
  createJob(document, permission) { return createAdapters().ocr.createJob(document, permission); },
  getJob(providerJobId, permission) { return createAdapters().ocr.getJob(providerJobId, permission); },
};
export const modelAdapter = {
  async extract(_boundedEvidencePacket) { throw new UnconfiguredConnectorError('Model provider'); },
  async review(_candidateFindings) { throw new UnconfiguredConnectorError('Model provider'); },
};
export const institutionalAdapter = {
  send(approvedMinimalQuestion, permission) { return createAdapters().institutional.send(approvedMinimalQuestion, permission); },
};
