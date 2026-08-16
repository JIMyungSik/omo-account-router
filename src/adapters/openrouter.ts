import type { OarStore } from "../store.ts";
import { GenericAdapter } from "./generic.ts";

/**
 * OpenRouter auth.json slot is `type: "oauth"` but the access token behaves
 * as a long-lived/permanent key (no refresh_token rotation endpoint is
 * exposed by OpenRouter's PKCE flow once exchanged). Do not invent a refresh
 * flow — this is a thin, documented specialization of GenericAdapter.
 */
export class OpenrouterAdapter extends GenericAdapter {
  constructor(store: OarStore) {
    super("openrouter", store);
  }
}
