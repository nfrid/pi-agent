import {
  dashboardHttpClient,
  gitContextQueryOptions,
} from '@pi-dashboard/client';
import type {
  CheckoutSummary,
  ModelSelection,
  RuntimeSnapshot,
} from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { type DraftLocation, setDraftLocation, setDraftModel } from '../drafts';
import {
  type ModelDisplayPreferences,
  modelDisplayPreference,
  useModelDisplayPreferences,
} from '../model-display-preferences';
import {
  draftRuntimeOptions,
  modelOptionValue,
  type RuntimeModelOption,
  rememberDraftRuntimeOptions,
} from '../model-option';

function modelName(
  model: ModelSelection | undefined,
  models: readonly RuntimeModelOption[],
  preferences: ModelDisplayPreferences,
): string {
  if (!model) return 'Agent';
  const option = models.find(
    (item) => item.provider === model.provider && item.model === model.model,
  );
  const preference = modelDisplayPreference(
    preferences,
    model.provider,
    model.model,
  );
  return preference.alias ?? option?.name ?? model.model;
}

function checkoutReason(checkout: CheckoutSummary): string | undefined {
  if (checkout.activeRunId) return 'Active run';
  if (checkout.status === 'preparing') return 'Preparing';
  if (checkout.status === 'merging') return 'Merging';
  if (checkout.status === 'failed') return 'Unavailable';
  if (checkout.status === 'retired') return 'Retired';
  return undefined;
}

function checkoutLabel(checkout: CheckoutSummary): string {
  return checkout.branch ?? checkout.path.split('/').pop() ?? checkout.id;
}

function useEscapeDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open || typeof globalThis.addEventListener !== 'function') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener?.('keydown', onKeyDown);
  }, [open, close]);
}

function PickerSurface({
  label,
  title,
  onClose,
  onBack,
  children,
}: {
  label: string;
  title: string;
  onClose: () => void;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="draft-picker-backdrop"
        aria-label={`Close ${label}`}
        onClick={onClose}
      />
      <div
        className="draft-picker-popover"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="draft-picker-heading">
          <div>
            {onBack && (
              <Button
                type="button"
                className="draft-picker-back"
                aria-label="Back"
                onPress={onBack}
              >
                ←
              </Button>
            )}
            <span>{title}</span>
          </div>
          <Button
            type="button"
            className="draft-picker-close"
            onPress={onClose}
          >
            Done
          </Button>
        </div>
        <div className="draft-picker-content">{children}</div>
      </div>
    </>
  );
}

function PickerRow({
  label,
  detail,
  color,
  selected,
  drillIn,
  disabled,
  onPress,
}: {
  label: string;
  detail?: string;
  color?: string;
  selected?: boolean;
  drillIn?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      type="button"
      className={`draft-picker-option${selected ? ' selected' : ''}`}
      isDisabled={disabled}
      aria-pressed={selected || undefined}
      onPress={onPress}
    >
      <span className="draft-picker-option-copy">
        <span style={color ? { color } : undefined}>{label}</span>
        {detail && <small>{detail}</small>}
      </span>
      {(selected || drillIn) && (
        <span className="draft-picker-option-mark" aria-hidden="true">
          {selected ? '✓' : '›'}
        </span>
      )}
    </Button>
  );
}

export function ThreadLocationIndicator({
  checkout,
}: {
  checkout: CheckoutSummary | undefined;
}) {
  const branch = checkout?.branch ?? checkout?.path.split('/').pop();
  const prefix =
    checkout?.kind === 'main'
      ? 'Current checkout'
      : checkout?.kind === 'worktree'
        ? 'wt'
        : 'Checkout';
  return (
    <span
      className={`draft-picker-trigger draft-picker-trigger-locked location-picker location-${checkout?.kind ?? 'unknown'}`}
      title={checkout?.path}
    >
      <svg
        className="draft-picker-location-icon"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <path d="M1.5 3.5h5l1.25 1.5h6.75v7.5h-13z" />
      </svg>
      <span>{branch ? `${prefix} · ${branch}` : 'Thread checkout'}</span>
    </span>
  );
}

export function DraftLocationPicker({
  draftId,
  location,
  projectId,
  projectRoot,
  checkouts,
  disabled,
}: {
  draftId: string;
  location: DraftLocation;
  projectId: string;
  projectRoot: string;
  checkouts: readonly CheckoutSummary[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'branches' | 'checkouts'>('root');
  const [search, setSearch] = useState('');
  const context = useQuery({
    ...gitContextQueryOptions(dashboardHttpClient, projectId),
    enabled: open,
  });
  const main =
    checkouts.find(
      (checkout) => checkout.kind === 'main' && checkout.path === projectRoot,
    ) ?? checkouts.find((checkout) => checkout.kind === 'main');
  const existing = checkouts.filter((checkout) => checkout.id !== main?.id);
  const selectedBranch =
    location.kind === 'worktree' && location.base === 'branch'
      ? location.baseRef
      : undefined;
  const close = () => {
    setOpen(false);
    setView('root');
    setSearch('');
  };
  const choose = (next: DraftLocation) => {
    setDraftLocation(draftId, next);
    close();
  };
  useEscapeDismiss(open, close);
  const query = search.trim().toLowerCase();
  const branches = (context.data?.localBranches ?? []).filter((branch) =>
    branch.toLowerCase().includes(query),
  );
  const visibleCheckouts = existing.filter((checkout) =>
    `${checkoutLabel(checkout)} ${checkout.path}`.toLowerCase().includes(query),
  );
  const currentBranch = context.data?.branch ?? main?.branch ?? 'main';
  const currentDirty = context.data?.dirty ?? main?.status === 'dirty';
  const currentChangedFileCount =
    context.data?.changedFileCount ?? main?.changedFileCount;
  const selectedCheckout =
    location.kind === 'checkout'
      ? checkouts.find((item) => item.id === location.checkoutId)
      : undefined;
  const summary =
    location.kind === 'current'
      ? `Current checkout · ${currentBranch}`
      : location.kind === 'checkout'
        ? `Existing · ${selectedCheckout ? checkoutLabel(selectedCheckout) : 'checkout'}`
        : `New wt · ${
            location.base === 'work'
              ? 'current work'
              : location.base === 'head'
                ? 'HEAD'
                : (selectedBranch ?? 'branch')
          }`;
  const title =
    view === 'branches'
      ? 'Choose a branch'
      : view === 'checkouts'
        ? 'Existing checkouts'
        : 'Location';

  return (
    <div className="draft-picker draft-location-picker">
      <Button
        type="button"
        className={`draft-picker-trigger location-${location.kind}`}
        isDisabled={disabled}
        aria-label="Checkout location"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => (open ? close() : setOpen(true))}
      >
        <svg
          className="draft-picker-location-icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M1.5 3.5h5l1.25 1.5h6.75v7.5h-13z" />
        </svg>
        <span>{summary}</span>
      </Button>
      {open && (
        <PickerSurface
          label="Checkout location"
          title={title}
          onClose={close}
          onBack={
            view === 'root'
              ? undefined
              : () => {
                  setView('root');
                  setSearch('');
                }
          }
        >
          {view === 'root' ? (
            <>
              <div className="draft-picker-section">Workspace</div>
              <PickerRow
                label="Current checkout"
                detail={
                  currentDirty
                    ? currentChangedFileCount === undefined
                      ? 'Changed checkout'
                      : `${currentChangedFileCount} changed files`
                    : 'Use the project checkout directly'
                }
                selected={location.kind === 'current'}
                disabled={Boolean(main && checkoutReason(main))}
                onPress={() => main && choose({ kind: 'current' })}
              />
              {!context.error && (
                <>
                  <div className="draft-picker-section">New worktree</div>
                  <PickerRow
                    label="Current work"
                    detail="Carry uncommitted changes"
                    selected={
                      location.kind === 'worktree' && location.base === 'work'
                    }
                    onPress={() => choose({ kind: 'worktree', base: 'work' })}
                  />
                  <PickerRow
                    label="Current HEAD"
                    detail="Start from the current commit"
                    selected={
                      location.kind === 'worktree' && location.base === 'head'
                    }
                    onPress={() => choose({ kind: 'worktree', base: 'head' })}
                  />
                  <PickerRow
                    label="Choose a branch"
                    detail={selectedBranch}
                    selected={Boolean(selectedBranch)}
                    drillIn={!selectedBranch}
                    onPress={() => {
                      setView('branches');
                      setSearch('');
                    }}
                  />
                </>
              )}
              {existing.length > 0 && (
                <>
                  <div className="draft-picker-section">Reuse</div>
                  <PickerRow
                    label="Existing checkout"
                    detail={
                      selectedCheckout
                        ? checkoutLabel(selectedCheckout)
                        : `${existing.length} available`
                    }
                    selected={Boolean(selectedCheckout)}
                    drillIn={!selectedCheckout}
                    onPress={() => {
                      setView('checkouts');
                      setSearch('');
                    }}
                  />
                </>
              )}
              {context.error && (
                <small className="draft-picker-error">
                  New worktree options are unavailable. You can still use an
                  existing checkout.
                </small>
              )}
            </>
          ) : (
            <>
              <input
                className="draft-picker-search"
                aria-label={
                  view === 'branches'
                    ? 'Search local branches'
                    : 'Search existing checkouts'
                }
                placeholder={
                  view === 'branches' ? 'Search branches…' : 'Search checkouts…'
                }
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value.slice(0, 512))
                }
              />
              <div className="draft-picker-results" role="listbox">
                {view === 'branches'
                  ? branches.map((branch) => (
                      <PickerRow
                        key={branch}
                        label={branch}
                        selected={selectedBranch === branch}
                        onPress={() =>
                          choose({
                            kind: 'worktree',
                            base: 'branch',
                            baseRef: branch,
                          })
                        }
                      />
                    ))
                  : visibleCheckouts.map((checkout) => {
                      const reason = checkoutReason(checkout);
                      return (
                        <PickerRow
                          key={checkout.id}
                          label={checkoutLabel(checkout)}
                          detail={
                            reason ??
                            (checkout.status === 'dirty'
                              ? checkout.changedFileCount === undefined
                                ? 'Changed checkout'
                                : `${checkout.changedFileCount} changed files`
                              : 'Ready')
                          }
                          selected={selectedCheckout?.id === checkout.id}
                          disabled={Boolean(reason)}
                          onPress={() =>
                            choose({
                              kind: 'checkout',
                              checkoutId: checkout.id,
                            })
                          }
                        />
                      );
                    })}
                {(view === 'branches' ? branches : visibleCheckouts).length ===
                  0 && (
                  <small className="draft-picker-empty">
                    No matching results.
                  </small>
                )}
              </div>
            </>
          )}
        </PickerSurface>
      )}
    </div>
  );
}

export function AgentPicker({
  model,
  models,
  levels,
  disabled,
  pending,
  error,
  onModelChange,
  onThinkingChange,
}: {
  model: ModelSelection | undefined;
  models: readonly RuntimeModelOption[];
  levels: readonly string[];
  disabled: boolean;
  pending?: boolean;
  error?: string;
  onModelChange: (model: { provider: string; model: string }) => void;
  onThinkingChange: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscapeDismiss(open, close);
  const preferences = useModelDisplayPreferences();
  const selectedValue = model
    ? modelOptionValue(model.provider, model.model)
    : '';
  const selectedPreference = model
    ? modelDisplayPreference(preferences, model.provider, model.model)
    : {};
  return (
    <div className="draft-picker draft-agent-picker">
      <Button
        type="button"
        className="draft-picker-trigger draft-agent-trigger"
        data-thinking={model?.thinking}
        isDisabled={disabled}
        aria-label="Agent and thinking"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPress={() => (open ? close() : setOpen(true))}
      >
        <span
          className="draft-agent-model"
          style={
            selectedPreference.color
              ? { color: selectedPreference.color }
              : undefined
          }
          title={model ? `${model.provider}/${model.model}` : undefined}
        >
          {modelName(model, models, preferences)}
        </span>
        {model?.thinking && (
          <span className="draft-agent-thinking">· {model.thinking}</span>
        )}
      </Button>
      {open && (
        <PickerSurface label="Agent and thinking" title="Agent" onClose={close}>
          <div className="draft-picker-section">Model</div>
          {models.map((item) => {
            const value = modelOptionValue(item.provider, item.model);
            const preference = modelDisplayPreference(
              preferences,
              item.provider,
              item.model,
            );
            const label = preference.alias ?? item.name ?? item.model;
            return (
              <PickerRow
                key={value}
                label={label}
                detail={`${item.provider}/${item.model}`}
                color={preference.color}
                selected={value === selectedValue}
                disabled={pending}
                onPress={() =>
                  onModelChange({ provider: item.provider, model: item.model })
                }
              />
            );
          })}
          {levels.length > 0 && (
            <>
              <div className="draft-picker-section">Thinking</div>
              <fieldset className="draft-picker-chips">
                <legend className="sr-only">Thinking level</legend>
                {levels.map((level) => (
                  <Button
                    key={level}
                    type="button"
                    className={`draft-picker-chip${model?.thinking === level ? ' selected' : ''}`}
                    data-thinking={level}
                    isDisabled={!model || pending}
                    aria-pressed={model?.thinking === level}
                    onPress={() => onThinkingChange(level)}
                  >
                    {level}
                  </Button>
                ))}
              </fieldset>
            </>
          )}
          {error && (
            <small className="draft-picker-error" role="alert">
              {error}
            </small>
          )}
        </PickerSurface>
      )}
    </div>
  );
}

export function DraftAgentPicker({
  draftId,
  model,
  runtimes,
  disabled,
}: {
  draftId: string;
  model: ModelSelection | undefined;
  runtimes: readonly RuntimeSnapshot[];
  disabled: boolean;
}) {
  const runtimeOptions = draftRuntimeOptions(runtimes);
  const configuredModels = runtimeOptions.models;
  const models =
    model &&
    !configuredModels.some(
      (option) =>
        modelOptionValue(option.provider, option.model) ===
        modelOptionValue(model.provider, model.model),
    )
      ? [model, ...configuredModels]
      : configuredModels;
  const levels = [
    ...new Set([
      ...runtimeOptions.thinkingLevels,
      ...(model?.thinking ? [model.thinking] : []),
    ]),
  ];
  useEffect(() => {
    rememberDraftRuntimeOptions(runtimes);
  }, [runtimes]);
  return (
    <AgentPicker
      model={model}
      models={models}
      levels={levels}
      disabled={disabled}
      onModelChange={(next) =>
        setDraftModel(draftId, {
          ...next,
          ...(model?.thinking ? { thinking: model.thinking } : {}),
        })
      }
      onThinkingChange={(thinking) => {
        if (model) setDraftModel(draftId, { ...model, thinking });
      }}
    />
  );
}
