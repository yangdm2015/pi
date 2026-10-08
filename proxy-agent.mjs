import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new EnvHttpProxyAgent());
