"use client";

import { useEffect, useRef, useState } from "react";
import { submitFeedback, submitQuery, type QueryMode, type QueryResponse } from "@/lib/api";
import styles from "./Chat.module.css";

type Message =
  | { type: "user"; text: string }
  | { type: "bot"; data: QueryResponse; mode: QueryMode }
  | { type: "loading" };

const WELCOME: QueryResponse = {
  answer:
    "Hello. I support frontline health workers using the Nigeria Standard Treatment Guidelines.\n\nAsk about assessment, treatment, referral, or dosing and I will answer with structured guidance and citations.\n\nWhat would you like to know?",
  disposition: "ANSWER",
  citations: [],
  warnings: [],
};

export function Chat() {
  const [mode] = useState<QueryMode>("clinical");
  const [messages, setMessages] = useState<Message[]>([{ type: "bot", data: WELCOME, mode: "clinical" }]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingClarification, setPendingClarification] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 130) + "px";
  }

  async function handleSend() {
    const text = query.trim();
    if (!text || loading) return;

    // If the last bot message was a clarification request, combine with original query
    const fullQuery = pendingClarification
      ? `${pendingClarification} — ${text}`
      : text;

    setQuery("");
    setPendingClarification(null);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setLoading(true);
    setMessages((prev) => [...prev, { type: "user", text }, { type: "loading" }]);

    try {
      const data = await submitQuery(mode, fullQuery);
      if (data.disposition === "ASK_CLARIFY") {
        setPendingClarification(fullQuery);
      }
      setMessages((prev) => [
        ...prev.filter((m) => m.type !== "loading"),
        { type: "bot", data, mode },
      ]);
    } catch {
      const errResponse: QueryResponse = {
        answer: "Could not reach the server. Please check your connection and try again.",
        disposition: "ERROR",
        citations: [],
        warnings: [],
      };
      setMessages((prev) => [
        ...prev.filter((m) => m.type !== "loading"),
        { type: "bot", data: errResponse, mode },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className={styles.wrap}>
      {/* Mode header */}
      <div className={styles.tabs} role="status" aria-live="polite">
        <div className={`${styles.tab} ${styles.tabClinical}`}>
          Frontline Clinical Support
        </div>
      </div>

      {/* Chat card */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={`${styles.dot} ${styles.dotClinical}`} />
          <span className={styles.modeLabel}>
            Frontline — structured answers, dosing, citations
          </span>
        </div>

        {/* Thread */}
        <div className={styles.thread} ref={threadRef}>
          {messages.map((msg, i) => {
            if (msg.type === "loading") return <LoadingBubble key={i} />;
            if (msg.type === "user") return <UserBubble key={i} text={msg.text} />;
            return <BotBubble key={i} data={msg.data} mode={msg.mode} />;
          })}
        </div>

        {/* Input */}
        <div className={styles.inputRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            value={query}
            placeholder="E.g. Child with fever and fast breathing — what should I do?"
            onChange={(e) => {
              setQuery(e.target.value);
              autoResize(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            className={`${styles.sendBtn} ${styles.sendBtnClinical}`}
            onClick={() => void handleSend()}
            disabled={loading || !query.trim()}
            aria-label="Send"
          >
            ▶
          </button>
        </div>
      </div>

      {/* Disclaimer */}
      <p className={styles.disclaimer}>
        ⚠ This tool supports decision-making but does not replace a qualified clinician.
        In an emergency, go to the nearest hospital immediately.
      </p>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className={`${styles.msgRow} ${styles.msgUser}`}>
      <div className={styles.userBubble}>{text}</div>
    </div>
  );
}

function BotBubble({ data, mode }: { data: QueryResponse; mode: QueryMode }) {
  const [feedbackSent, setFeedbackSent] = useState(false);

  async function handleFeedback(rating: "up" | "down") {
    if (!data.interaction_id || feedbackSent) return;
    try {
      await submitFeedback(data.interaction_id, rating);
      setFeedbackSent(true);
    } catch {
      // silent
    }
  }

  const dispClass = {
    ANSWER: styles.dispAnswer,
    EMERGENCY_ESCALATE: styles.dispDanger,
    UNCERTAIN_ESCALATE: styles.dispAmber,
    INSUFFICIENT_EVIDENCE: styles.dispAmber,
    ASK_CLARIFY: styles.dispAmber,
    ERROR: styles.dispDanger,
  }[data.disposition] ?? styles.dispAnswer;

  return (
    <div className={`${styles.msgRow} ${styles.msgBot} ${mode === "clinical" ? styles.msgBotClinical : ""}`}>
      <div className={styles.botBubble}>
        <p className={styles.botText}>{data.answer}</p>

        <span className={`${styles.disp} ${dispClass}`}>
          {data.disposition.replace(/_/g, " ")}
        </span>

        {/* Dosage */}
        {data.dosage && (data.dosage.dose_mg != null || data.dosage.dose_range_mg?.length === 2) && (
          <div className={styles.dosagePill}>
            ▶ Dose:{" "}
            {data.dosage.dose_range_mg?.length === 2
              ? `${data.dosage.dose_range_mg[0]}–${data.dosage.dose_range_mg[1]} mg`
              : `${data.dosage.dose_mg} mg`}
            {data.dosage.medication ? ` — ${data.dosage.medication}` : ""}
          </div>
        )}

        {/* Warnings */}
        {data.warnings.map((w, i) => (
          <div key={i} className={styles.warning}>⚠ {w}</div>
        ))}

        {/* Citations */}
        {data.citations.length > 0 && (
          <div className={styles.citations}>
            <span className={styles.citationsLabel}>Sources (NSTG)</span>
            {data.citations.map((c, i) => (
              <div key={i} className={styles.citationLine}>
                {c.condition}
                {c.section ? ` → ${c.section}` : ""}
                {c.subsection ? ` → ${c.subsection}` : ""}
                {c.page ? ` (p.${c.page})` : ""}
              </div>
            ))}
          </div>
        )}

        {/* Feedback */}
        {data.interaction_id && (
          <div className={styles.feedback}>
            {feedbackSent ? (
              <span className={styles.feedbackSent}>Thank you for your feedback.</span>
            ) : (
              <>
                <button className={styles.feedbackBtn} onClick={() => void handleFeedback("up")}>
                  👍 Helpful
                </button>
                <button className={styles.feedbackBtn} onClick={() => void handleFeedback("down")}>
                  👎 Needs review
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingBubble() {
  return (
    <div className={`${styles.msgRow} ${styles.msgBot}`}>
      <div className={styles.loadingBubble}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
