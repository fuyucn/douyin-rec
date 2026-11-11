/**
 * LoginScreen — 远程访问开启鉴权时的密钥登录页（issue #600）。
 * 登录成功种 HttpOnly 会话票据后整页重载，让所有数据 hooks 用新票据重新拉取。
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { errMessage } from "../lib/hooks";
import { useT } from "../lib/i18n";

export function LoginScreen(): ReactNode {
  const t = useT();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(value);
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t("auth.wrong") : errMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100dvh] grid place-items-center px-4">
      <form onSubmit={(e) => void submit(e)} className="card w-full max-w-sm p-6 flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t("auth.title")}</h1>
          <p className="text-muted text-sm mt-2 leading-relaxed">{t("auth.desc")}</p>
        </div>
        <label className="field">
          <span className="field-label">{t("auth.token")}</span>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error ? <p className="text-xs text-error-fg" role="alert">{error}</p> : null}
        <button type="submit" className="btn-primary" disabled={busy || !token.trim()}>
          {busy ? t("auth.checking") : t("auth.submit")}
        </button>
      </form>
    </div>
  );
}
