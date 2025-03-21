import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'chai';
import { spy } from 'sinon';
import type { SinonSpy } from 'sinon';
import { Provider } from 'react-redux';

import configureStore from '../../../../test/configure-store';
import { PipelineHeader } from '.';

describe('PipelineHeader', function () {
  let container: HTMLElement;
  let onShowSavedPipelinesSpy: SinonSpy;
  let onToggleOptionsSpy: SinonSpy;
  beforeEach(function () {
    onShowSavedPipelinesSpy = spy();
    onToggleOptionsSpy = spy();
    render(
      <Provider store={configureStore()}>
        <PipelineHeader
          isOpenPipelineVisible
          isSavedPipelineVisible={false}
          isOptionsVisible
          showRunButton
          showExportButton
          showExplainButton
          onToggleSavedPipelines={onShowSavedPipelinesSpy}
          onToggleOptions={onToggleOptionsSpy}
        />
      </Provider>
    );
    container = screen.getByTestId('pipeline-header');
  });

  it('renders pipeline text heading', function () {
    expect(within(container).getByText('Pipeline')).to.exist;
  });

  it('open saved pipelines button', function () {
    const button = within(container).getByTestId(
      'pipeline-toolbar-open-pipelines-button'
    );
    expect(button).to.exist;

    userEvent.click(button);

    expect(onShowSavedPipelinesSpy.calledOnce).to.be.true;
  });
});
