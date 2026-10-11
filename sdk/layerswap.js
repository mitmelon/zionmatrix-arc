// Thin server-side client for LayerSwap's v2 Deposit API.
// Keep the API key on your backend; never expose it in a browser bundle.
class LayerSwap {
  constructor({ apiKey, baseUrl = 'https://api.layerswap.io', sandbox = false, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error('LayerSwap requires an apiKey');
    if (!fetchImpl) throw new Error('A fetch implementation is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sandbox = sandbox;
    this.fetch = fetchImpl;
  }

  async sources({ destinationNetwork, destinationToken = 'USDC' } = {}) {
    return this._get('/api/v2/sources', { destination_network: destinationNetwork, destination_token: destinationToken, has_deposit_address: true, sandbox: this.sandbox || undefined });
  }

  async destinations({ sourceNetwork, sourceToken = 'USDC' } = {}) {
    return this._get('/api/v2/destinations', { source_network: sourceNetwork, source_token: sourceToken, sandbox: this.sandbox || undefined });
  }

  async quote({ sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', amount }) {
    return this._get('/api/v2/detailed_quote', {
      source_network: sourceNetwork, source_token: sourceToken,
      destination_network: destinationNetwork, destination_token: destinationToken, amount,
    });
  }

  // Explicit alias for the LayerSwap detailed quote endpoint. The response is the same shape as
  // the docs: { error, data: [{ ... fee fields ... path: [...] }] }.
  async detailedQuote({ sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', amount }) {
    return this.quote({ sourceNetwork, sourceToken, destinationNetwork, destinationToken, amount });
  }

  async createSwap({ sourceNetwork, sourceToken = 'USDC', destinationNetwork, destinationToken = 'USDC', destinationAddress, amount, referenceId }) {
    const humanAmount = Number(amount);
    if (!Number.isFinite(humanAmount) || humanAmount <= 0) throw new Error('amount must be a positive human-readable token amount');
    return this._request('/api/v2/swaps', 'POST', {
      source_network: sourceNetwork, source_token: sourceToken,
      destination_network: destinationNetwork, destination_token: destinationToken,
      destination_address: destinationAddress, amount: humanAmount, reference_id: referenceId,
      refuel: false, use_deposit_address: true,
    });
  }

  async swap(id) { return this._get(`/api/v2/swaps/${encodeURIComponent(id)}`); }

  async _get(path, query) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return this._request(url.pathname + url.search, 'GET');
  }

  async _request(path, method, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-LS-APIKEY': this.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || payload.message || `LayerSwap request failed (${response.status})`);
    return payload.data ?? payload;
  }
}

module.exports = { LayerSwap };
