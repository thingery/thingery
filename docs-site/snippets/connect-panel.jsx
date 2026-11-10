// One place to connect any client: a tab per client, each with install rows. Styles live in
// style.css (the tg-connect classes) so they do not depend on Tailwind scanning snippets.
export const ConnectPanel = ({ url = "https://thingery.dev/mcp" }) => {
  const [active, setActive] = useState("claude");
  const [copied, setCopied] = useState("");

  const copy = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      setTimeout(() => setCopied(""), 1500);
    });
  };

  const cursorConfig = typeof btoa === "function" ? btoa(JSON.stringify({ url })) : "";
  const vscodeConfig = JSON.stringify({ name: "thingery", type: "http", url });

  const icons = {
    claude: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="#D97757">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    ),
    chatgpt: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    ),
    cursor: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5z M3.5 7.25 12 12l8.5-4.75 M12 12v9.5" />
      </svg>
    ),
    others: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 7V3 M15 7V3 M6 7h12v4a6 6 0 0 1-12 0z M12 17v4" />
      </svg>
    ),
  };

  const tabs = [
    {
      id: "claude",
      label: "Claude",
      rows: [
        {
          title: "Claude app",
          body: "Opens claude.ai with the connector filled in. Add it, then sign in. It works in Claude Desktop and the mobile apps too.",
          action: {
            label: "Add connector",
            href: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Thingery&connectorUrl=${encodeURIComponent(url)}`,
          },
        },
        {
          title: "Claude Code",
          body: "Run this command in your terminal, then run /mcp in Claude Code to sign in.",
          code: `claude mcp add --transport http thingery ${url}`,
        },
      ],
    },
    {
      id: "chatgpt",
      label: "ChatGPT",
      rows: [
        {
          title: "ChatGPT connector",
          body: "In ChatGPT settings, create a connector with this URL, then sign in.",
          action: { label: "Open ChatGPT", href: "https://chatgpt.com/#settings/Connectors" },
          code: url,
        },
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      rows: [
        {
          title: "One-click install",
          body: "Opens Cursor and adds the Thingery server. Sign in when Cursor asks.",
          action: {
            label: "Add to Cursor",
            href: `cursor://anysphere.cursor-deeplink/mcp/install?name=thingery&config=${cursorConfig}`,
          },
        },
        {
          title: "Manual setup",
          body: "Or add this to .cursor/mcp.json.",
          code: JSON.stringify({ mcpServers: { thingery: { url } } }, null, 2),
        },
      ],
    },
    {
      id: "others",
      label: "Others",
      rows: [
        {
          title: "VS Code",
          body: "Opens VS Code and adds the Thingery server.",
          action: { label: "Add to VS Code", href: `vscode:mcp/install?${encodeURIComponent(vscodeConfig)}` },
          code: `code --add-mcp '${vscodeConfig}'`,
        },
        {
          title: "Any MCP client",
          body: "Add this URL as a remote server over Streamable HTTP. Clients without OAuth send an API key instead.",
          code: url,
        },
      ],
    },
  ];

  const current = tabs.find((tab) => tab.id === active);

  return (
    <div className="tg-connect not-prose">
      <div className="tg-connect-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            className="tg-connect-tab"
            onClick={() => setActive(tab.id)}
          >
            {icons[tab.id]}
            {tab.label}
          </button>
        ))}
      </div>
      {current.rows.map((row) => (
        <div key={row.title} className="tg-connect-row">
          <div className="tg-connect-head">
            <div>
              <p className="tg-connect-title">{row.title}</p>
              <p className="tg-connect-body">{row.body}</p>
            </div>
            {row.action && (
              <a className="tg-connect-action" href={row.action.href} target="_blank" rel="noopener noreferrer">
                {row.action.label}
                <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
          {row.code && (
            <div className="tg-connect-code">
              <pre>
                <code>{row.code}</code>
              </pre>
              <button
                type="button"
                className="tg-connect-copy"
                onClick={() => copy(row.code)}
                aria-label={`Copy ${row.title}`}
              >
                {copied === row.code ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
