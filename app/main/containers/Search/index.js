/* eslint default-case: 0 */

import React, { Component, PropTypes } from 'react'
import { connect } from 'react-redux'
import { bindActionCreators } from 'redux'
import { clipboard, remote } from 'electron'
import MainInput from '../../components/MainInput'
import ResultsList from '../../components/ResultsList'
import styles from './styles.css'
import { focusableSelector } from 'cerebro-ui'
import * as searchActions from '../../actions/search'
import escapeStringRegexp from 'escape-string-regexp'

import { debounce, bind } from 'lodash-decorators'

import trackEvent from 'lib/trackEvent'
import getWindowPosition from 'lib/getWindowPosition'

import {
  WINDOW_WIDTH,
  INPUT_HEIGHT,
  RESULT_HEIGHT,
  MIN_VISIBLE_RESULTS,
} from '../../constants/ui'

const SHOW_EVENT = {
  category: 'Window',
  event: 'show'
}

const SELECT_EVENT = {
  category: 'Plugins',
  event: 'select'
}

const trackShowWindow = () => trackEvent(SHOW_EVENT)
const trackSelectItem = (label) => trackEvent({ ...SELECT_EVENT, label })

/**
 * Wrap click or mousedown event to custom `select-item` event,
 * that includes only information about clicked keys (alt, shift, ctrl and meta)
 *
 * @param  {Event} realEvent
 * @return {CustomEvent}
 */
const wrapEvent = (realEvent) => {
  const event = new CustomEvent('select-item', { cancelable: true })
  event.altKey = realEvent.altKey
  event.shiftKey = realEvent.shiftKey
  event.ctrlKey = realEvent.ctrlKey
  event.metaKey = realEvent.metaKey
  return event
}

/**
 * Set focus to first focusable element in preview
 */
const focusPreview = () => {
  const previewDom = document.getElementById('preview')
  const firstFocusable = previewDom.querySelector(focusableSelector)
  if (firstFocusable) {
    firstFocusable.focus()
  }
}

/**
 * Check if cursor in the end of input
 *
 * @param  {DOMElement} input
 */
const cursorInEndOfInut = ({ selectionStart, selectionEnd, value }) => (
  selectionStart === selectionEnd && selectionStart >= value.length
)

/**
 * Main search container
 *
 * TODO: Remove redux
 * TODO: Split to more components
 */
class Search extends Component {
  constructor(props) {
    super(props)
    this.electronWindow = remote.getCurrentWindow()
    this.state = {
      mainInputFocused: false
    }
  }

  componentWillMount() {
    // Listen for window.resize and change default space for results to user's value
    window.addEventListener('resize', this.onWindowResize)
    // Add some global key handlers
    window.addEventListener('keydown', this.onDocumentKeydown)
    // Cleanup event listeners on unload
    // NOTE: when page refreshed (location.reload) componentWillUnmount is not called
    window.addEventListener('beforeunload', this.cleanup)
    this.electronWindow.on('show', this.focusMainInput)
    this.electronWindow.on('show', this.updateElectronWindow)
    this.electronWindow.on('show', trackShowWindow)
  }
  componentDidMount() {
    this.focusMainInput()
    this.updateElectronWindow()
  }
  componentDidUpdate(prevProps) {
    const { results } = this.props
    if (results.length !== prevProps.results.length) {
      // Resize electron window when results count changed
      this.updateElectronWindow()
    }
  }
  componentWillUnmount() {
    this.cleanup()
  }

  /**
   * Handle resize window and change count of visible results depends on window size
   */
  @bind()
  @debounce(100)
  onWindowResize() {
    if (this.props.results.length <= MIN_VISIBLE_RESULTS) {
      return false
    }
    let visibleResults = Math.floor((window.outerHeight - INPUT_HEIGHT) / RESULT_HEIGHT)
    visibleResults = Math.max(MIN_VISIBLE_RESULTS, visibleResults)
    if (visibleResults !== this.props.visibleResults) {
      this.props.actions.changeVisibleResults(visibleResults)
    }
  }

  @bind()
  onDocumentKeydown(event) {
    if (event.keyCode === 27) {
      event.preventDefault()
      document.getElementById('main-input').focus()
    }
  }

  /**
   * Handle keyboard shortcuts
   */
  @bind()
  onKeyDown(event) {
    const highlighted = this.highlightedResult()
    // TODO: go to first result on cmd+up and last result on cmd+down
    if (highlighted && highlighted.onKeyDown) {
      highlighted.onKeyDown(event)
    }
    if (event.defaultPrevented) {
      return
    }

    const keyActions = {
      select: () => {
        this.selectCurrent(event)
      },
      arrowRight: () => {
        if (cursorInEndOfInut(event.target)) {
          if (this.autocompleteValue()) {
            // Autocomplete by arrow right only if autocomple value is shown
            this.autocomplete(event)
          } else {
            focusPreview()
            event.preventDefault()
          }
        }
      },
      arrowDown: () => {
        this.props.actions.moveCursor(1)
        event.preventDefault()
      },
      arrowUp: () => {
        if (this.props.results.length > 0) {
          this.props.actions.moveCursor(-1)
        } else if (this.props.prevTerm) {
          this.props.actions.updateTerm(this.props.prevTerm)
        }
        event.preventDefault()
      }
    }


    if (event.metaKey || event.ctrlKey) {
      if (event.keyCode === 67) {
        // Copy to clipboard on cmd+c
        const text = this.highlightedResult().clipboard
        if (text) {
          clipboard.writeText(text)
          this.props.actions.reset()
          event.preventDefault()
        }
        return
      }
      if (event.keyCode >= 49 && event.keyCode <= 57) {
        // Select element by number
        const number = Math.abs(49 - event.keyCode)
        const result = this.props.results[number]
        if (result) {
          return this.selectItem(result)
        }
      }
      // Lightweight vim-mode: cmd/ctrl + jklo
      switch (event.keyCode) {
        case 74:
          keyActions.arrowDown()
          break
        case 75:
          keyActions.arrowUp()
          break
        case 76:
          keyActions.arrowRight()
          break
        case 79:
          keyActions.select()
          break
      }
    }
    switch (event.keyCode) {
      case 9:
        this.autocomplete(event)
        break
      case 39:
        keyActions.arrowRight()
        break
      case 40:
        keyActions.arrowDown()
        break
      case 38:
        keyActions.arrowUp()
        break
      case 13:
        keyActions.select()
        break
      case 27:
        this.props.actions.reset()
        this.electronWindow.hide()
        break
    }
  }

  @bind()
  onMainInputFocus() {
    this.setState({ mainInputFocused: true })
  }

  @bind()
  onMainInputBlur() {
    this.setState({ mainInputFocused: false })
  }

  @bind()
  cleanup() {
    window.removeEventListener('resize', this.onWindowResize)
    window.removeEventListener('keydown', this.onDocumentKeydown)
    window.removeEventListener('beforeunload', this.cleanup)
    this.electronWindow.removeListener('show', this.focusMainInput)
    this.electronWindow.removeListener('show', this.updateElectronWindow)
    this.electronWindow.removeListener('show', trackShowWindow)
  }

  @bind()
  focusMainInput() {
    this.refs.mainInput.focus()
  }

  /**
   * Get highlighted result
   * @return {Object}
   */
  highlightedResult() {
    return this.props.results[this.props.selected]
  }

  /**
   * Select item from results list
   * @param  {[type]} item [description]
   * @return {[type]}      [description]
   */
  @bind()
  selectItem(item, realEvent) {
    this.props.actions.reset()
    trackSelectItem(item.plugin)
    const event = wrapEvent(realEvent)
    item.onSelect(event)
    if (!event.defaultPrevented) {
      this.electronWindow.hide()
    }
  }

  /**
   * Autocomple search term from highlighted result
   */
  autocomplete(event) {
    const { term } = this.highlightedResult()
    if (term && term !== this.props.term) {
      this.props.actions.updateTerm(term)
      event.preventDefault()
    }
  }
  /**
   * Select highlighted element
   */
  selectCurrent(event) {
    this.selectItem(this.highlightedResult(), event)
  }

  /**
   * Set resizable and size for main electron window when results count is changed
   */
  @bind()
  @debounce(16)
  updateElectronWindow() {
    const { results, visibleResults } = this.props
    const { length } = results
    const win = this.electronWindow
    const [width] = win.getSize()

    // When results list is empty window is not resizable
    win.setResizable(length !== 0)

    if (length === 0) {
      win.setMinimumSize(WINDOW_WIDTH, INPUT_HEIGHT)
      win.setSize(width, INPUT_HEIGHT)
      win.setPosition(...getWindowPosition({ width }))
      return
    }

    const resultHeight = Math.max(Math.min(visibleResults, length), MIN_VISIBLE_RESULTS)
    const heightWithResults = resultHeight * RESULT_HEIGHT + INPUT_HEIGHT
    const minHeightWithResults = MIN_VISIBLE_RESULTS * RESULT_HEIGHT + INPUT_HEIGHT
    win.setMinimumSize(WINDOW_WIDTH, minHeightWithResults)
    win.setSize(width, heightWithResults)
    win.setPosition(...getWindowPosition({ width, heightWithResults }))
  }

  autocompleteValue() {
    const selected = this.highlightedResult()
    if (selected && selected.term) {
      const regexp = new RegExp(`^${escapeStringRegexp(this.props.term)}`, 'i')
      if (selected.term.match(regexp)) {
        return selected.term.replace(regexp, this.props.term)
      }
    }
    return ''
  }
  /**
   * Render autocomplete suggestion from selected item
   * @return {React}
   */
  renderAutocomplete() {
    const term = this.autocompleteValue()
    if (term) {
      return <div className={styles.autocomplete}>{term}</div>
    }
  }
  render() {
    const { mainInputFocused } = this.state
    return (
      <div className={styles.search}>
        {this.renderAutocomplete()}
        <div className={styles.inputWrapper}>
          <MainInput
            value={this.props.term}
            ref="mainInput"
            onChange={this.props.actions.updateTerm}
            onKeyDown={this.onKeyDown}
            onFocus={this.onMainInputFocus}
            onBlur={this.onMainInputBlur}
          />
        </div>
        <ResultsList
          results={this.props.results}
          selected={this.props.selected}
          visibleResults={this.props.visibleResults}
          onItemHover={this.props.actions.selectElement}
          onSelect={this.selectItem}
          mainInputFocused={mainInputFocused}
        />
      </div>
    )
  }
}

Search.propTypes = {
  actions: PropTypes.shape({
    reset: PropTypes.func,
    moveCursor: PropTypes.func,
    updateTerm: PropTypes.func,
    changeVisibleResults: PropTypes.func,
    selectElement: PropTypes.func,
  }),
  results: PropTypes.array,
  selected: PropTypes.number,
  visibleResults: PropTypes.number,
  term: PropTypes.string,
  prevTerm: PropTypes.string,
}

function mapStateToProps(state) {
  return {
    selected: state.search.selected,
    results: state.search.resultIds.map(id => state.search.resultsById[id]),
    term: state.search.term,
    prevTerm: state.search.prevTerm,
    visibleResults: state.search.visibleResults,
  }
}

function mapDispatchToProps(dispatch) {
  return {
    actions: bindActionCreators(searchActions, dispatch),
  }
}

export default connect(mapStateToProps, mapDispatchToProps)(Search)
