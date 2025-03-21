import type { AggregateOptions, Document } from 'mongodb';
import type { Stage } from '@mongodb-js/explain-plan-helper';
import { ExplainPlan } from '@mongodb-js/explain-plan-helper';
import { capMaxTimeMSAtPreferenceLimit } from 'compass-preferences-model';
import type AppRegistry from 'hadron-app-registry';
import type { DataService, ExplainExecuteOptions } from 'mongodb-data-service';
import type { Action, AnyAction, Reducer } from 'redux';
import { applyMiddleware, createStore } from 'redux';
import type { ThunkAction } from 'redux-thunk';
import thunk from 'redux-thunk';
import createLoggerAndTelemetry from '@mongodb-js/compass-logging';

const { log, mongoLogId, track } =
  createLoggerAndTelemetry('COMPASS-EXPLAIN-UI');

export function isAction<A extends AnyAction>(
  action: AnyAction,
  type: A['type']
): action is A {
  return action.type === type;
}

type SerializedExplainPlan = ReturnType<ExplainPlan['serialize']>;

enum ExplainPlanModalActionTypes {
  CloseExplainPlanModal = 'compass-explain-plan-modal/CloseExplainPlanModal',
  FetchExplainPlanModalLoading = 'compass-explain-plan-modal/FetchExplainPlanModalLoading',
  FetchExplainPlanModalSuccess = 'compass-explain-plan-modal/FetchExplainPlanModalSuccess',
  FetchExplainPlanModalError = 'compass-explain-plan-modal/FetchExplainPlanModalError',
}

type CloseExplainPlanModalAction = {
  type: ExplainPlanModalActionTypes.CloseExplainPlanModal;
};

type FetchExplainPlanModalLoadingAction = {
  type: ExplainPlanModalActionTypes.FetchExplainPlanModalLoading;
  id: number;
};

type FetchExplainPlanModalSuccessAction = {
  type: ExplainPlanModalActionTypes.FetchExplainPlanModalSuccess;
  explainPlan: SerializedExplainPlan;
  rawExplainPlan: unknown;
};

type FetchExplainPlanModalErrorAction = {
  type: ExplainPlanModalActionTypes.FetchExplainPlanModalError;
  error: string;
  rawExplainPlan: unknown;
};

export type ExplainPlanModalState = {
  namespace: string;
  isDataLake: boolean;
  error: string | null;
  isModalOpen: boolean;
  status: 'initial' | 'loading' | 'ready' | 'error';
  explainPlan: SerializedExplainPlan | null;
  rawExplainPlan: unknown | null;
  explainPlanFetchId: number;
};

type ExplainPlanDataService = Pick<
  DataService,
  'explainAggregate' | 'isCancelError'
>;

type ExplainPlanModalExtraArgs = {
  dataService: ExplainPlanDataService;
};

type ExplainPlanModalThunkAction<R, A extends Action = AnyAction> = ThunkAction<
  R,
  ExplainPlanModalState,
  ExplainPlanModalExtraArgs,
  A
>;

const INITIAL_STATE: ExplainPlanModalState = {
  namespace: '',
  isDataLake: false,
  error: null,
  isModalOpen: false,
  status: 'initial',
  explainPlan: null,
  rawExplainPlan: null,
  explainPlanFetchId: -1,
};

export const reducer: Reducer<ExplainPlanModalState> = (
  state = INITIAL_STATE,
  action
) => {
  if (
    isAction<FetchExplainPlanModalLoadingAction>(
      action,
      ExplainPlanModalActionTypes.FetchExplainPlanModalLoading
    )
  ) {
    return {
      ...state,
      isModalOpen: true,
      status: 'loading',
      error: null,
      explainPlan: null,
      rawExplainPlan: null,
      explainPlanFetchId: action.id,
    };
  }

  if (
    isAction<FetchExplainPlanModalSuccessAction>(
      action,
      ExplainPlanModalActionTypes.FetchExplainPlanModalSuccess
    )
  ) {
    return {
      ...state,
      status: 'ready',
      explainPlan: action.explainPlan,
      rawExplainPlan: action.rawExplainPlan,
      explainPlanFetchId: -1,
    };
  }

  if (
    isAction<FetchExplainPlanModalErrorAction>(
      action,
      ExplainPlanModalActionTypes.FetchExplainPlanModalError
    )
  ) {
    return {
      ...state,
      status: 'error',
      explainPlan: null,
      error: action.error,
      rawExplainPlan: action.rawExplainPlan,
      explainPlanFetchId: -1,
    };
  }

  if (
    isAction<CloseExplainPlanModalAction>(
      action,
      ExplainPlanModalActionTypes.CloseExplainPlanModal
    )
  ) {
    return {
      ...state,
      // We don't reset the state completely so that the closing modal content
      // doesn't jump during closing animation
      isModalOpen: false,
    };
  }

  return state;
};

type OpenExplainPlanModalEvent =
  | { query: unknown; aggregation?: never }
  | {
      query?: never;
      aggregation: {
        pipeline: Document[];
        collation?: AggregateOptions['collation'];
      };
    };

const ExplainPlanAbortControllerMap = new Map<number, AbortController>();

let explainPlanFetchId = 0;

function getAbortSignal() {
  const id = ++explainPlanFetchId;
  const controller = new AbortController();
  ExplainPlanAbortControllerMap.set(id, controller);
  return { id, signal: controller.signal };
}

function abort(id: number) {
  const controller = ExplainPlanAbortControllerMap.get(id);
  controller?.abort();
  return ExplainPlanAbortControllerMap.delete(id);
}

function cleanupAbortSignal(id: number) {
  return ExplainPlanAbortControllerMap.delete(id);
}

const getAggregationExplainVerbosity = (
  pipeline: unknown[],
  isDataLake: boolean
): ExplainExecuteOptions['explainVerbosity'] => {
  // dataLake does not have $out/$merge operators
  if (isDataLake) {
    return 'queryPlannerExtended';
  }
  const lastStage = pipeline[pipeline.length - 1] ?? {};
  const isOutOrMergePipeline =
    Object.prototype.hasOwnProperty.call(lastStage, '$out') ||
    Object.prototype.hasOwnProperty.call(lastStage, '$merge');
  return isOutOrMergePipeline
    ? 'queryPlanner' // $out & $merge only work with queryPlanner
    : 'allPlansExecution';
};

const DEFAULT_MAX_TIME_MS = 60_000;

export const openExplainPlanModal = (
  event: OpenExplainPlanModalEvent
): ExplainPlanModalThunkAction<Promise<void>> => {
  return async (dispatch, getState, { dataService }) => {
    const { id: fetchId, signal } = getAbortSignal();

    let rawExplainPlan;
    let explainPlan;

    dispatch({
      type: ExplainPlanModalActionTypes.FetchExplainPlanModalLoading,
      id: fetchId,
    });

    const explainOptions = {
      maxTimeMS: capMaxTimeMSAtPreferenceLimit(DEFAULT_MAX_TIME_MS),
    };

    try {
      if (event.aggregation) {
        const { pipeline, collation } = event.aggregation;
        const { isDataLake, namespace } = getState();
        const explainVerbosity = getAggregationExplainVerbosity(
          pipeline,
          isDataLake
        );

        rawExplainPlan = await dataService.explainAggregate(
          namespace,
          pipeline,
          { ...explainOptions, collation },
          { explainVerbosity, abortSignal: signal }
        );

        try {
          explainPlan = new ExplainPlan(rawExplainPlan as Stage).serialize();
        } catch (err) {
          log.warn(
            mongoLogId(1_001_000_137),
            'Explain',
            'Failed to parse aggregation explain',
            { message: (err as Error).message }
          );
          throw err;
        }

        track('Aggregation Explained', {
          num_stages: pipeline.length,
          index_used: explainPlan.usedIndexes.length > 0,
        });
      }

      dispatch({
        type: ExplainPlanModalActionTypes.FetchExplainPlanModalSuccess,
        explainPlan,
        rawExplainPlan,
      });
    } catch (err) {
      if (dataService.isCancelError(err)) {
        // Cancellation can be caused only by close modal action and handled
        // there
        return;
      }
      log.error(mongoLogId(1_001_000_138), 'Explain', 'Failed to run explain', {
        message: (err as Error).message,
      });
      dispatch({
        type: ExplainPlanModalActionTypes.FetchExplainPlanModalError,
        error: (err as Error).message,
        rawExplainPlan,
      });
    } finally {
      // Remove AbortController from the Map as we either finished waiting for
      // the fetch or cancelled at this point
      cleanupAbortSignal(fetchId);
    }
  };
};

export const closeExplainPlanModal = (): ExplainPlanModalThunkAction<void> => {
  return (dispatch, getState) => {
    abort(getState().explainPlanFetchId);
    dispatch({
      type: ExplainPlanModalActionTypes.CloseExplainPlanModal,
    });
  };
};

export type ExplainPlanModalConfigureStoreOptions = {
  localAppRegistry: Pick<AppRegistry, 'on'>;
  dataProvider?: {
    dataProvider?: ExplainPlanDataService;
  };
  namespace: string;
  isDataLake: boolean;
};

export function configureStore({
  localAppRegistry,
  dataProvider,
  namespace,
  isDataLake,
}: ExplainPlanModalConfigureStoreOptions) {
  if (!dataProvider?.dataProvider) {
    throw new Error('Explain Plan plugin requires dataService to be provided');
  }

  const store = createStore(
    reducer,
    { ...INITIAL_STATE, namespace, isDataLake },
    applyMiddleware(
      thunk.withExtraArgument({
        dataService: dataProvider.dataProvider,
      })
    )
  );

  localAppRegistry.on('open-explain-plan-modal', (event) => {
    void store.dispatch(
      openExplainPlanModal(event as OpenExplainPlanModalEvent)
    );
  });

  return store;
}
