import {
  createProjectMutationOptions,
  dashboardHttpClient,
  dashboardQueryKeys,
  renameProjectMutationOptions,
  resetDashboardDefaultModelMutationOptions,
  resetModelDisplayPreferenceMutationOptions,
  settingsQueryOptions,
  updateDashboardDefaultModelMutationOptions,
  updateModelDisplayPreferenceMutationOptions,
  updateProjectDefaultModelMutationOptions,
} from '@pi-dashboard/client';
import '@arkn/react-icon-picker/dist/style.css';
import {
  type BrowserSnapshot,
  type ComposerFileSuggestion,
  type DashboardSettings,
  MAX_MODEL_DISPLAY_ALIAS,
  type ModelDisplayPreference,
  type ModelSelection,
} from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { MAX_IMAGE_SIZE } from '../shared/image-attachments';
import { errorMessage } from '../shared/lib/error-message';
import {
  setTranscriptPreviewPreference,
  TRANSCRIPT_PREVIEW_MAX,
  TRANSCRIPT_PREVIEW_MIN,
  useTranscriptPreviewPreference,
} from '../shared/lib/transcript-display';
import {
  modelDisplayPreferenceKey,
  normalizeModelDisplayPreference,
  useModelDisplayPreferences,
} from './model-display-preferences';
import {
  configuredModelOptions,
  draftRuntimeOptions,
  modelOptionValue,
  parseModelOptionValue,
  type RuntimeModelOption,
} from './model-option';
import { PushButton } from './notifications';
import { ProjectIcon, refreshProjectIcon } from './project-icon';
import styles from './settings.module.css';

export function SettingsView({ snapshot }: { snapshot: BrowserSnapshot }) {
  return (
    <section className={styles.settings}>
      <section
        className={styles.section}
        aria-labelledby="settings-alerts-heading"
      >
        <h3 id="settings-alerts-heading">Alert delivery</h3>
        <div className={styles.controls}>
          <span>Browser push</span>
          <PushButton />
        </div>
      </section>
      <TranscriptDisplayPreferences />
      <DraftDefaultSettings snapshot={snapshot} />
      <ModelDisplayPreferencesEditor snapshot={snapshot} />
      <ProjectAdministration snapshot={snapshot} />
    </section>
  );
}

function TranscriptDisplayPreferences() {
  const preference = useTranscriptPreviewPreference();
  const setCount = (key: 'start' | 'end', value: number) =>
    setTranscriptPreviewPreference({ ...preference, [key]: value });
  return (
    <section
      className={styles.section}
      aria-labelledby="settings-transcript-heading"
    >
      <h3 id="settings-transcript-heading">Transcript</h3>
      <p className={styles.hint}>
        Choose how many steps collapsed activity shows from each end.
      </p>
      <div className={styles.numberControls}>
        <label>
          <span>Steps from start</span>
          <input
            type="number"
            aria-label="Steps shown from start"
            min={TRANSCRIPT_PREVIEW_MIN}
            max={TRANSCRIPT_PREVIEW_MAX}
            value={preference.start}
            onChange={(event) =>
              setCount('start', event.currentTarget.valueAsNumber)
            }
          />
        </label>
        <label>
          <span>Steps from end</span>
          <input
            type="number"
            aria-label="Steps shown from end"
            min={TRANSCRIPT_PREVIEW_MIN}
            max={TRANSCRIPT_PREVIEW_MAX}
            value={preference.end}
            onChange={(event) =>
              setCount('end', event.currentTarget.valueAsNumber)
            }
          />
        </label>
      </div>
    </section>
  );
}

function DefaultModelControl({
  label,
  value,
  models,
  levels,
  disabled,
  onSave,
  onReset,
}: {
  label: string;
  value: ModelSelection | undefined;
  models: readonly RuntimeModelOption[];
  levels: readonly string[];
  disabled: boolean;
  onSave: (model: ModelSelection) => void;
  onReset: () => void;
}) {
  const [selection, setSelection] = useState<ModelSelection | undefined>(value);
  useEffect(() => {
    setSelection(value);
  }, [value]);
  const valueKey = selection
    ? modelOptionValue(selection.provider, selection.model)
    : '';
  const selectModel = (nextValue: string) => {
    const next = parseModelOptionValue(nextValue);
    if (!next) {
      setSelection(undefined);
      onReset();
      return;
    }
    const nextSelection: ModelSelection = {
      ...next,
      ...(selection?.thinking ? { thinking: selection.thinking } : {}),
      ...(next.provider === 'openai-codex' && selection?.serviceTier
        ? { serviceTier: selection.serviceTier }
        : {}),
    };
    setSelection(nextSelection);
    onSave(nextSelection);
  };
  const saveThinking = (thinking: string) => {
    if (!selection) return;
    const next = { ...selection };
    if (thinking) next.thinking = thinking;
    else delete next.thinking;
    setSelection(next);
    onSave(next);
  };
  const saveSpeed = (speed: string) => {
    if (selection?.provider !== 'openai-codex') return;
    const { serviceTier: _current, ...withoutSpeed } = selection;
    const next =
      speed === 'normal'
        ? withoutSpeed
        : { ...withoutSpeed, serviceTier: speed as 'fast' | 'ultrafast' };
    setSelection(next);
    onSave(next);
  };
  return (
    <div className={styles.defaultModelRow}>
      <div className={styles.defaultModelLabel}>{label}</div>
      <label>
        <span className="sr-only">{label} model</span>
        <select
          aria-label={`${label} model`}
          value={valueKey}
          disabled={disabled}
          onChange={(event) => selectModel(event.currentTarget.value)}
        >
          <option value="">Inherit / none</option>
          {models.map((model) => (
            <option
              key={modelOptionValue(model.provider, model.model)}
              value={modelOptionValue(model.provider, model.model)}
            >
              {model.name ?? model.model} ({model.provider})
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">{label} effort</span>
        <select
          aria-label={`${label} effort`}
          value={selection?.thinking ?? ''}
          disabled={disabled || !selection}
          onChange={(event) => saveThinking(event.currentTarget.value)}
        >
          <option value="">Pi default effort</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">{label} speed</span>
        <select
          aria-label={`${label} speed`}
          value={selection?.serviceTier ?? 'normal'}
          disabled={disabled || selection?.provider !== 'openai-codex'}
          onChange={(event) => saveSpeed(event.currentTarget.value)}
        >
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
          <option value="ultrafast">Ultrafast</option>
        </select>
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || !selection}
        onClick={() => {
          setSelection(undefined);
          onReset();
        }}
      >
        Reset to inherit
      </button>
    </div>
  );
}

function DraftDefaultSettings({ snapshot }: { snapshot: BrowserSnapshot }) {
  const settingsQuery = useQuery(settingsQueryOptions(dashboardHttpClient));
  const queryClient = useQueryClient();
  const updateGlobal = useMutation(
    updateDashboardDefaultModelMutationOptions(dashboardHttpClient),
  );
  const resetGlobal = useMutation(
    resetDashboardDefaultModelMutationOptions(dashboardHttpClient),
  );
  const updateProject = useMutation(
    updateProjectDefaultModelMutationOptions(dashboardHttpClient),
  );
  const runtimeOptions = draftRuntimeOptions(snapshot.runtimes ?? []);
  const models = [
    ...runtimeOptions.models,
    ...(settingsQuery.data?.defaultModel
      ? [settingsQuery.data.defaultModel]
      : []),
    ...(snapshot.projects ?? []).flatMap((project) =>
      project.defaultModel ? [project.defaultModel] : [],
    ),
  ];
  const uniqueModels = [
    ...new Map(
      models.map((model) => [
        modelOptionValue(model.provider, model.model),
        model,
      ]),
    ).values(),
  ];
  const levels = [
    ...new Set([
      ...runtimeOptions.thinkingLevels,
      ...(settingsQuery.data?.defaultModel?.thinking
        ? [settingsQuery.data.defaultModel.thinking]
        : []),
      ...(snapshot.projects ?? []).flatMap((project) =>
        project.defaultModel?.thinking ? [project.defaultModel.thinking] : [],
      ),
    ]),
  ];
  const refreshDraftDefaults = () =>
    void queryClient.invalidateQueries({
      queryKey: ['dashboard', 'draft-defaults'],
    });
  const saveGlobal = (model: ModelSelection) => {
    void updateGlobal.mutateAsync({ model }).then((saved) => {
      queryClient.setQueryData(dashboardQueryKeys.settings(), saved);
      refreshDraftDefaults();
    });
  };
  const resetGlobalDefault = () => {
    void resetGlobal.mutateAsync().then((saved) => {
      queryClient.setQueryData(dashboardQueryKeys.settings(), saved);
      refreshDraftDefaults();
    });
  };
  const saveProject = (projectId: string, model: ModelSelection) => {
    void updateProject
      .mutateAsync({ projectId, defaultModel: model })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: dashboardQueryKeys.draftDefaults(projectId),
        }),
      );
  };
  const resetProject = (projectId: string) => {
    void updateProject.mutateAsync({ projectId, defaultModel: null }).then(() =>
      queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.draftDefaults(projectId),
      }),
    );
  };
  const activeProjects = (snapshot.projects ?? []).filter(
    (project) => project.status === 'active',
  );
  return (
    <section
      className={styles.section}
      aria-labelledby="settings-draft-defaults-heading"
    >
      <h3 id="settings-draft-defaults-heading">Draft defaults</h3>
      <p className={styles.hint}>
        New drafts inherit project, dashboard, recent-thread, then Pi defaults.
        Reset a row to leave it unconfigured.
      </p>
      {(updateGlobal.isError ||
        resetGlobal.isError ||
        updateProject.isError) && (
        <small role="alert">Could not save draft defaults.</small>
      )}
      <div className={styles.defaultModels}>
        <DefaultModelControl
          label="Dashboard"
          value={settingsQuery.data?.defaultModel}
          models={uniqueModels}
          levels={levels}
          disabled={!settingsQuery.data}
          onSave={saveGlobal}
          onReset={resetGlobalDefault}
        />
        {activeProjects.map((project) => (
          <DefaultModelControl
            key={project.id}
            label={project.title}
            value={project.defaultModel}
            models={uniqueModels}
            levels={levels}
            disabled={!settingsQuery.data}
            onSave={(model) => saveProject(project.id, model)}
            onReset={() => resetProject(project.id)}
          />
        ))}
      </div>
    </section>
  );
}

const DEFAULT_MODEL_COLOR = '#8be9fd';
const DRACULA_MODEL_COLORS = [
  { name: 'Purple', value: '#bd93f9' },
  { name: 'Pink', value: '#ff79c6' },
  { name: 'Cyan', value: '#8be9fd' },
  { name: 'Green', value: '#50fa7b' },
  { name: 'Orange', value: '#ffb86c' },
  { name: 'Red', value: '#ff5555' },
  { name: 'Yellow', value: '#f1fa8c' },
] as const;

function ModelDisplayPreferencesEditor({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
}) {
  const preferences = useModelDisplayPreferences();
  const settingsQuery = useQuery(settingsQueryOptions(dashboardHttpClient));
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    updateModelDisplayPreferenceMutationOptions(dashboardHttpClient),
  );
  const resetMutation = useMutation(
    resetModelDisplayPreferenceMutationOptions(dashboardHttpClient),
  );
  const editSequence = useRef(0);
  const latestEditByKey = useRef(new Map<string, number>());
  const models = modelOptionsFromSnapshot(snapshot);
  const controlsDisabled = !settingsQuery.data;
  const saveModelPreference = (
    modelKey: string,
    edit?: (current: ModelDisplayPreference) => ModelDisplayPreference,
  ): void => {
    const sequence = ++editSequence.current;
    latestEditByKey.current.set(modelKey, sequence);
    void queryClient
      .cancelQueries({ queryKey: dashboardQueryKeys.settings() })
      .then(
        () => {
          const current =
            queryClient.getQueryData<DashboardSettings>(
              dashboardQueryKeys.settings(),
            ) ?? settingsQuery.data;
          if (!current || latestEditByKey.current.get(modelKey) !== sequence)
            return;
          const currentPreference = Object.hasOwn(
            current.modelDisplayPreferences,
            modelKey,
          )
            ? current.modelDisplayPreferences[modelKey]
            : {};
          const preference = edit
            ? normalizeModelDisplayPreference(edit(currentPreference))
            : undefined;
          const nextPreferences = { ...current.modelDisplayPreferences };
          if (preference) {
            Object.defineProperty(nextPreferences, modelKey, {
              configurable: true,
              enumerable: true,
              value: preference,
              writable: true,
            });
          } else delete nextPreferences[modelKey];
          queryClient.setQueryData(dashboardQueryKeys.settings(), {
            ...current,
            modelDisplayPreferences: nextPreferences,
          });
          const request = preference
            ? updateMutation.mutateAsync({ modelKey, preference })
            : resetMutation.mutateAsync({ modelKey });
          void request
            .then((saved) => {
              if (latestEditByKey.current.get(modelKey) !== sequence) return;
              if (editSequence.current === sequence) {
                queryClient.setQueryData(dashboardQueryKeys.settings(), saved);
                return;
              }
              queryClient.setQueryData(
                dashboardQueryKeys.settings(),
                (latest: DashboardSettings | undefined) => {
                  if (!latest) return latest;
                  const latestPreferences = {
                    ...latest.modelDisplayPreferences,
                  };
                  if (Object.hasOwn(saved.modelDisplayPreferences, modelKey)) {
                    Object.defineProperty(latestPreferences, modelKey, {
                      configurable: true,
                      enumerable: true,
                      value: saved.modelDisplayPreferences[modelKey],
                      writable: true,
                    });
                  } else delete latestPreferences[modelKey];
                  return {
                    ...latest,
                    modelDisplayPreferences: latestPreferences,
                  };
                },
              );
            })
            .catch(() => undefined)
            .finally(() => {
              if (latestEditByKey.current.get(modelKey) === sequence)
                void queryClient.invalidateQueries({
                  queryKey: dashboardQueryKeys.settings(),
                });
            });
        },
        () => {
          if (latestEditByKey.current.get(modelKey) === sequence)
            void queryClient.invalidateQueries({
              queryKey: dashboardQueryKeys.settings(),
            });
        },
      );
  };
  const savePreferences = (
    modelKey: string,
    edit: (current: ModelDisplayPreference) => ModelDisplayPreference,
  ): void => saveModelPreference(modelKey, edit);

  return (
    <details
      className={`${styles.section} ${styles.disclosure}`}
      aria-labelledby="settings-model-display-heading"
    >
      <summary id="settings-model-display-heading">
        <span className={styles.disclosureTitle}>Model display</span>
        <small className={styles.disclosureSummary}>Aliases and colors</small>
      </summary>
      <p className={styles.hint}>
        Choose compact aliases and colors for thread metadata. These settings
        are shared across connected devices.
      </p>
      {(updateMutation.isError || resetMutation.isError) && (
        <small role="alert">Could not save model display settings.</small>
      )}
      <div className={styles.modelPreferences}>
        {models.map((model) => {
          const key = modelDisplayPreferenceKey(model.provider, model.model);
          const preference = Object.hasOwn(preferences, key)
            ? preferences[key]
            : {};
          const selectedColor = preference.color ?? DEFAULT_MODEL_COLOR;
          const setColor = (color: string) =>
            savePreferences(key, (current) => ({ ...current, color }));
          return (
            <div className={styles.modelPreference} key={key}>
              <span className={styles.modelPreferenceId} title={key}>
                {model.name ?? model.model}
                <small>{model.provider}</small>
              </span>
              <label className={styles.modelAlias}>
                <span className="sr-only">Alias for {key}</span>
                <input
                  aria-label={`Alias for ${key}`}
                  value={preference.alias ?? ''}
                  placeholder={model.model}
                  maxLength={MAX_MODEL_DISPLAY_ALIAS}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    const alias = event.currentTarget.value.slice(
                      0,
                      MAX_MODEL_DISPLAY_ALIAS,
                    );
                    savePreferences(key, (current) => ({
                      ...current,
                      ...(alias ? { alias } : { alias: undefined }),
                    }));
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={
                  controlsDisabled ||
                  (preference.alias === undefined &&
                    preference.color === undefined)
                }
                onClick={() => saveModelPreference(key)}
              >
                Reset
              </button>
              <fieldset className={styles.modelColorControls}>
                <legend className="sr-only">Colors for {key}</legend>
                {DRACULA_MODEL_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={styles.modelColorPreset}
                    style={{ backgroundColor: color.value }}
                    aria-label={`Use ${color.name} for ${key}`}
                    aria-pressed={selectedColor === color.value}
                    title={color.name}
                    disabled={controlsDisabled}
                    onClick={() => setColor(color.value)}
                  />
                ))}
                <label className={styles.modelColor}>
                  <span className="sr-only">Custom color for {key}</span>
                  <input
                    type="color"
                    aria-label={`Custom color for ${key}`}
                    value={selectedColor}
                    disabled={controlsDisabled}
                    onChange={(event) => setColor(event.target.value)}
                  />
                </label>
              </fieldset>
            </div>
          );
        })}
      </div>
      {!models.length && <p className="muted">No observed models yet.</p>}
    </details>
  );
}

function modelOptionsFromSnapshot(
  snapshot: BrowserSnapshot,
): readonly RuntimeModelOption[] {
  const observed = (snapshot.runtimes ?? []).flatMap((runtime) =>
    runtime.model
      ? [{ provider: runtime.model.provider, model: runtime.model.model }]
      : [],
  );
  return [
    ...new Map(
      [...configuredModelOptions(snapshot.runtimes ?? []), ...observed].map(
        (model) => [modelOptionValue(model.provider, model.model), model],
      ),
    ).values(),
  ];
}

const PROJECT_ICON_EXTENSIONS = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/iu;
const IconPicker = lazy(async () => {
  const module = await import('@arkn/react-icon-picker/dist/index.cjs');
  return { default: module.IconPicker };
});

function libraryProjectIconFile(svg: string): File {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const body = parsed.documentElement.innerHTML;
  const sourceViewBox = parsed.documentElement.getAttribute('viewBox') ?? '';
  const viewBox = /^-?[\d.]+(?:\s+-?[\d.]+){3}$/u.test(sourceViewBox)
    ? sourceViewBox
    : '0 0 24 24';
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="52" fill="#6d5bd0"/><svg x="32" y="32" width="192" height="192" viewBox="${viewBox}" color="white" fill="white">${body}</svg></svg>`;
  return new File([wrapped], 'library-icon.svg', { type: 'image/svg+xml' });
}

function LibraryIconPicker({ onSelect }: { onSelect: (svg: string) => void }) {
  return (
    <div className={styles.libraryPicker}>
      <Suspense fallback={<p className={styles.iconPickerLoading}>Loading…</p>}>
        <IconPicker
          value={null}
          valueType="svg"
          iconLibrary={['ph', 'tabler', 'material-symbols']}
          theme="dark"
          inputSize="small"
          placeholder="Search icons"
          searchPlaceholder="Search icons"
          emptyText="No icons found"
          onChange={(value) => {
            if (typeof value === 'string') onSelect(value);
          }}
        />
      </Suspense>
    </div>
  );
}

function ProjectAdministration({ snapshot }: { snapshot: BrowserSnapshot }) {
  const projects = (snapshot.projects ?? []).filter(
    (project) => project.status === 'active',
  );
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [iconPendingId, setIconPendingId] = useState<string>();
  const [iconPickerId, setIconPickerId] = useState<string>();
  const [iconPickerMode, setIconPickerMode] = useState<'icons' | 'files'>(
    'icons',
  );
  const [iconMenuPosition, setIconMenuPosition] = useState({
    top: 0,
    left: 0,
    maxHeight: 360,
  });
  const [fileQuery, setFileQuery] = useState('');
  const [fileSuggestions, setFileSuggestions] = useState<
    readonly ComposerFileSuggestion[]
  >([]);
  const [fileSuggestionsLoading, setFileSuggestionsLoading] = useState(false);
  const [customIconIds, setCustomIconIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [title, setTitle] = useState('');
  const iconPickerAnchorRef = useRef<HTMLButtonElement | null>(null);
  const createMutation = useMutation(
    createProjectMutationOptions(dashboardHttpClient),
  );
  const renameMutation = useMutation(
    renameProjectMutationOptions(dashboardHttpClient),
  );

  useLayoutEffect(() => {
    if (!iconPickerId || typeof window === 'undefined') return;
    const updatePosition = () => {
      const anchor = iconPickerAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = 260;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeBelow = below >= 260 || below >= above;
      const top = placeBelow
        ? rect.bottom + 8
        : Math.max(12, rect.top - Math.min(360, above) - 8);
      setIconMenuPosition({
        top,
        left: Math.max(
          12,
          Math.min(rect.left - 6, window.innerWidth - width - 12),
        ),
        maxHeight: placeBelow
          ? Math.max(80, window.innerHeight - top - 12)
          : Math.max(80, rect.top - top - 8),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [iconPickerId]);

  useEffect(() => {
    if (iconPickerMode !== 'files' || !iconPickerId) return;
    const controller = new AbortController();
    let active = true;
    setFileSuggestionsLoading(true);
    const timeout = window.setTimeout(() => {
      void dashboardHttpClient
        .projectIconFiles(iconPickerId, fileQuery, controller.signal)
        .then((response) => {
          if (!active) return;
          setFileSuggestions(
            response.suggestions.filter(
              (suggestion) =>
                suggestion.directory ||
                PROJECT_ICON_EXTENSIONS.test(suggestion.value),
            ),
          );
        })
        .catch(() => {
          if (active) setFileSuggestions([]);
        })
        .finally(() => {
          if (active) setFileSuggestionsLoading(false);
        });
    }, 120);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [fileQuery, iconPickerId, iconPickerMode]);

  useEffect(() => {
    if (!iconPickerId || typeof document === 'undefined') return;
    const closeOutside = (event: PointerEvent) => {
      const owner =
        event.target instanceof Element
          ? event.target.closest(
              '[data-project-icon-editor], [data-project-icon-menu]',
            )
          : null;
      const ownerId =
        owner?.getAttribute('data-project-icon-editor') ??
        owner?.getAttribute('data-project-icon-menu');
      if (ownerId !== iconPickerId) setIconPickerId(undefined);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setIconPickerId(undefined);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [iconPickerId]);

  const addProject = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = rootPath.trim();
    if (
      !candidate.startsWith('/') &&
      candidate !== '~' &&
      !candidate.startsWith('~/')
    ) {
      setError('Use an absolute path or ~/.');
      return;
    }
    setError(undefined);
    try {
      await createMutation.mutateAsync({ rootPath: candidate });
      setRootPath('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const recordCustomIcon = (projectId: string, custom: boolean) => {
    setCustomIconIds((current) => {
      if (current.has(projectId) === custom) return current;
      const next = new Set(current);
      if (custom) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const setIcon = async (
    projectId: string,
    file: File,
    input?: HTMLInputElement,
  ) => {
    if (file.size > MAX_IMAGE_SIZE) {
      setError('Project icons must be 5 MB or smaller.');
      if (input) input.value = '';
      return;
    }
    setError(undefined);
    setIconPickerId(undefined);
    setIconPendingId(projectId);
    try {
      await dashboardHttpClient.setProjectIcon(projectId, file);
      recordCustomIcon(projectId, true);
      refreshProjectIcon(projectId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (input) input.value = '';
      setIconPendingId(undefined);
    }
  };

  const setIconFromPath = async (projectId: string, relativePath: string) => {
    setError(undefined);
    setIconPickerId(undefined);
    setIconPendingId(projectId);
    try {
      await dashboardHttpClient.setProjectIconFromPath(projectId, relativePath);
      recordCustomIcon(projectId, true);
      refreshProjectIcon(projectId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIconPendingId(undefined);
    }
  };

  const resetIcon = async (projectId: string) => {
    setError(undefined);
    setIconPickerId(undefined);
    setIconPendingId(projectId);
    try {
      await dashboardHttpClient.resetProjectIcon(projectId);
      recordCustomIcon(projectId, false);
      refreshProjectIcon(projectId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIconPendingId(undefined);
    }
  };

  const rename = async (event: FormEvent, projectId: string) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || renameMutation.isPending) return;
    setError(undefined);
    try {
      await renameMutation.mutateAsync({
        projectId,
        command: { title: nextTitle },
      });
      setRenamingId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="settings-projects-heading"
    >
      <h3 id="settings-projects-heading">Projects</h3>
      <form
        className={styles.addForm}
        onSubmit={(event) => void addProject(event)}
      >
        <label className="sr-only" htmlFor="settings-project-root">
          Project path
        </label>
        <input
          id="settings-project-root"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="~/code/project"
          autoComplete="off"
          disabled={createMutation.isPending}
        />
        <button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Adding…' : 'Add'}
        </button>
      </form>
      <div className={styles.projects}>
        {projects.map((project) =>
          renamingId === project.id ? (
            <form
              className={styles.projectRow}
              key={project.id}
              onSubmit={(event) => void rename(event, project.id)}
            >
              <input
                aria-label={`Rename ${project.title}`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={renameMutation.isPending}
              />
              <button type="submit" disabled={renameMutation.isPending}>
                Save
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRenamingId(undefined)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className={styles.projectRow} key={project.id}>
              <span className={styles.projectIdentity}>
                <span
                  className={styles.iconEditor}
                  data-project-icon-editor={project.id}
                  data-pending={
                    iconPendingId === project.id ? 'true' : undefined
                  }
                >
                  <button
                    type="button"
                    className={styles.iconSelect}
                    aria-label={`Choose icon for ${project.title}`}
                    aria-expanded={iconPickerId === project.id}
                    disabled={iconPendingId !== undefined}
                    title="Choose a project icon"
                    onClick={(event) => {
                      if (iconPickerId === project.id) {
                        setIconPickerId(undefined);
                        return;
                      }
                      iconPickerAnchorRef.current = event.currentTarget;
                      setIconPickerMode('icons');
                      setFileQuery('');
                      setFileSuggestions([]);
                      setIconPickerId(project.id);
                    }}
                  >
                    <ProjectIcon
                      projectId={project.id}
                      title={project.title}
                      size="small"
                      onCustomChange={(custom) =>
                        recordCustomIcon(project.id, custom)
                      }
                    />
                  </button>
                  {iconPickerId === project.id &&
                    typeof document !== 'undefined' &&
                    createPortal(
                      <div
                        className={styles.iconMenu}
                        data-project-icon-menu={project.id}
                        role="dialog"
                        aria-label={`Icons for ${project.title}`}
                        style={iconMenuPosition}
                      >
                        {iconPickerMode === 'icons' ? (
                          <>
                            <LibraryIconPicker
                              onSelect={(svg) =>
                                void setIcon(
                                  project.id,
                                  libraryProjectIconFile(svg),
                                )
                              }
                            />
                            <div className={styles.iconMenuActions}>
                              <button
                                type="button"
                                onClick={() => {
                                  setFileQuery('./');
                                  setFileSuggestions([]);
                                  setIconPickerMode('files');
                                }}
                              >
                                Choose project file
                              </button>
                              <label>
                                Upload from device
                                <input
                                  type="file"
                                  accept="image/*,.ico,.svg"
                                  disabled={iconPendingId !== undefined}
                                  onChange={(event) => {
                                    const file = event.currentTarget.files?.[0];
                                    if (file)
                                      void setIcon(
                                        project.id,
                                        file,
                                        event.currentTarget,
                                      );
                                  }}
                                />
                              </label>
                            </div>
                          </>
                        ) : (
                          <div className={styles.projectFilePicker}>
                            <div className={styles.projectFileHeader}>
                              <button
                                type="button"
                                onClick={() => setIconPickerMode('icons')}
                              >
                                Back
                              </button>
                              <strong>Project files</strong>
                            </div>
                            <small className="path">{project.rootPath}</small>
                            <input
                              aria-label={`Search files in ${project.title}`}
                              value={fileQuery}
                              placeholder="Search image files"
                              onChange={(event) =>
                                setFileQuery(event.target.value.slice(0, 512))
                              }
                            />
                            <div className={styles.projectFileResults}>
                              {fileSuggestionsLoading && <p>Loading…</p>}
                              {!fileSuggestionsLoading &&
                                fileSuggestions.map((suggestion) => (
                                  <button
                                    type="button"
                                    key={`${suggestion.directory ? 'd' : 'f'}:${suggestion.value}`}
                                    onClick={() => {
                                      if (suggestion.directory)
                                        setFileQuery(suggestion.value);
                                      else
                                        void setIconFromPath(
                                          project.id,
                                          suggestion.value,
                                        );
                                    }}
                                  >
                                    <span>{suggestion.label}</span>
                                    {suggestion.directory && (
                                      <span aria-hidden="true">›</span>
                                    )}
                                  </button>
                                ))}
                              {!fileSuggestionsLoading &&
                                fileSuggestions.length === 0 && (
                                  <p>No image files found.</p>
                                )}
                            </div>
                          </div>
                        )}
                      </div>,
                      iconPickerAnchorRef.current?.closest<HTMLElement>(
                        '[data-surface-portal-root]',
                      ) ?? document.body,
                      project.id,
                    )}
                  {customIconIds.has(project.id) && (
                    <button
                      type="button"
                      className={styles.iconReset}
                      aria-label={`Use automatic icon for ${project.title}`}
                      disabled={iconPendingId !== undefined}
                      title="Use automatic icon"
                      onClick={() => void resetIcon(project.id)}
                    >
                      ×
                    </button>
                  )}
                </span>
                <span className={styles.projectCopy}>
                  <strong>{project.title}</strong>
                  <small>{project.rootPath}</small>
                </span>
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={iconPendingId !== undefined}
                onClick={() => {
                  setIconPickerId(undefined);
                  setTitle(project.title);
                  setRenamingId(project.id);
                }}
              >
                Rename
              </button>
            </div>
          ),
        )}
      </div>
      {!projects.length && <p className="muted">No projects yet.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
