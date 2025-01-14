import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Form,
  Input,
  Select,
  Table,
  Tooltip,
} from 'antd'
import { ConfigContext } from 'antd/es/config-provider/context'
import type { FormInstance, FormItemProps } from 'antd/es/form'
import type { InputProps } from 'antd/es/input'
import type { SelectProps } from 'antd/es/select'
import type {
  ColumnType as AntdColumnType,
  TablePaginationConfig,
  TableProps as AntdTableProps,
} from 'antd/es/table'
import type {
  FilterValue,
  SorterResult,
  TableCurrentDataSource,
  TableRowSelection,
} from 'antd/es/table/interface'
import { TooltipProps } from 'antd/es/tooltip'
import useTableSelections, { AntdTableSelectionResult } from './useSelections'

// 🚧-①: 屏蔽 React.StrictMode 副作用
// 🐞-①: 使用 render 实现的动态 Form.Item 会在表格增加、减少行时造成 Form 数据丢失！可以通过 🚧-② 绕开！
//       如果需要一个 cell 渲染多个 Form 组件，考虑使用多个相邻 cell + style 的方式实现，可以保障 Form 与 Table 字段一一对应！
//       渲染多个 Form 组件 Demo: https://github.com/hello-fe/hb-ui/blob/main/packages/antd/view/table-edit/index.tsx

// column.formItem vs column.render
// 使用 render 函数实现的 Form 元素比 formItem 配置出来的性能高些
// antd 自带的 render 通过 useMemo 优化过 https://github.com/react-component/table/blob/HEAD/src/Cell/index.tsx#L151-L198

export interface TableProps<RecordType = Record<string, any>> extends Omit<AntdTableProps<RecordType>, 'columns'> {
  columns?: (AntdColumnType<RecordType> & {
    formItem?: FormItemProps & {
      input?: InputProps | ((args: { form: FormInstance, record: RecordType, index: number }) => InputProps | void | null | undefined)
      select?: SelectProps | ((args: { form: FormInstance, record: RecordType, index: number }) => SelectProps | void | null | undefined)
      // 🐞-①: render props(小)
      render?: (args: { form: FormInstance, record: RecordType, index: number }) => React.ReactNode
    }
    // 🐞-①: render function(大) - Consider use `render` instead.
  })[]
  query?: (args: {
    /** 请求次数，当不想自动发起首次请求时可以判断 count==1 返回 undefined 打断请求 - 内部维护 */
    count: number
    /** 与后端交互只需 `current` `pageSize` `total` 三个属性即可 */
    pagination?: Partial<Pick<TablePaginationConfig, 'current' | 'pageSize' | 'total'>>
    /** 来自 handle.query 透传 */
    payload?: any
    /** Table 触发 change 透传 */
    changes?: {
      pagination: TablePaginationConfig
      filters: Record<string, FilterValue | null>
      sorter: SorterResult<RecordType> | SorterResult<RecordType[]>
      extra: TableCurrentDataSource<RecordType>
    }
  }) => Promise<({ data: RecordType[] } & Partial<Pick<TablePaginationConfig, 'current' | 'pageSize' | 'total'>>) | void>
  rowSelection?: Partial<TableRowSelection<RecordType> & { disabled: boolean | ((row: RecordType) => boolean) }>
  handle?: {
    selection: AntdTableSelectionResult<RecordType>['action'] & AntdTableSelectionResult<RecordType>['state'],
    query: (args?: Omit<Parameters<TableQuery<RecordType>>[0], 'count'>) => void
    // React 单项数据流设计，遂抛出 dataSource
    data: RecordType[]
    /** 可编辑表格每一行都是一个独立的 Form */
    forms: FormInstance[]
    /** 可编辑表格重置 */
    resetForms: () => void
  }
}

export type TableColumn<RecordType = Record<string, any>> = Required<TableProps<RecordType>>['columns'][number]
export type TableQuery<RecordType = Record<string, any>> = Required<TableProps<RecordType>>['query']
export type TableHandle<RecordType = Record<string, any>> = Required<TableProps<RecordType>>['handle']

const isObject = (any:any) => typeof any === 'object' && any !== null;

// Table 的可编辑表格的表单组件样式(对齐单元格)
function formatStyle(prefixCls = 'ant') {
  const id = 'tr-form-item_style'
  const className = 'tr-form-item'
  let oStyle = document.getElementById(id) as HTMLStyleElement
  if (oStyle) return

  oStyle = document.createElement<'style'>('style')
  oStyle.id = id
  oStyle.innerHTML = `.${className} .${prefixCls}-form-item { margin: 0; }`
  document.head.appendChild(oStyle)
}

function TableAntd<RecordType = Record<string, any>, FormValues = Record<string, any>>(props: TableProps<RecordType>) {
  const {
    columns,
    dataSource,
    handle,
    query,
    onChange,
    pagination: props_pagination,
    rowSelection: props_rowSelection,
    ...rest
  } = props
  const { getPrefixCls } = React.useContext(ConfigContext)

  const [data, setData] = useState(dataSource)
  const [page, setPage] = useState<TablePaginationConfig | false>(props_pagination === false ? false : {
    current: 1,
    pageSize: 10,
    showQuickJumper: true,
    showSizeChanger: true,
    ...props_pagination,
  })
  const [loading, setLoading] = useState(false)
  const queryCount = useRef(0)
  const queryArgs = useRef<Parameters<TableHandle['query']>[0]>() // query's args cache
  const mounted = useRef(false)
  const unMounted = useRef(false)
  const refTimer = useRef<any>() // NodeJS.Timeout 不一定会有
  const editable = useMemo(() => columns?.find(col => col.formItem), [columns])
  const { state: selection, action: selectionAction, rowSelection } = useTableSelections(
    data as Readonly<RecordType>[],
    { ...props_rowSelection, rowKey: rest.rowKey as any }
  )

  useLayoutEffect(() => {
    unMounted.current = false // 🚧-①
    formatStyle(getPrefixCls())
  }, [])

  // 请求
  const queryHandle = async (args: Parameters<TableHandle['query']>[0] = {}) => {
    if (!query) return
    queryCount.current++
    queryArgs.current = args

    const pagination = args.pagination ?? (typeof page === 'object' ? {
      current: page.current,
      pageSize: page.pageSize,
      total: page.total,
    } : undefined)

    // Useless attr
    delete pagination?.total

    setLoading(true)
    const result = await query({
      count: queryCount.current,
      pagination,
      payload: args.payload,
      // TODO: remove type assert
      changes: args.changes as any,
    })
    setLoading(false)
    if (!result) return // 打断请求 or 无效请求

    if (unMounted.current) return // 🚧-①

    const { data, ...restPage } = result
    setData(data)
    if (typeof page === 'object') {
      setPage({ ...page, ...restPage })
    }
  }

  // 外部传入 dataSource
  useEffect(() => {
    // initialized in `useState(dataSource)`
    mounted.current && setData(dataSource)
  }, [dataSource])

  // handle 挂载
  useEffect(() => {
    if (handle) {
      handle.query = (args = {}) => {
        if (page) {
          args.pagination = {
            // Reset `pagination.current` to 1 when invoke `handle.query`
            current: 1,
            pageSize: queryArgs.current?.pagination?.pageSize ?? page.pageSize,
            ...args.pagination,
          }
        }
        // TODO: remove type assert
        queryHandle(args as any)
      }
      handle.data = data as RecordType[]
      handle.resetForms = () => {
        // 🤔 出于性能及编程复杂度考虑，不使用 FormAPI 同步 dataSource，直接在此更新
        setData(resetDataSource(data!))
        for (const form of handle.forms) {
          form.resetFields()
        }
      }
      if (isObject(props_rowSelection)) {
        handle.selection = {
          // 🤔 handle只是引用，无法承载 React State
          ...selectionAction,
          ...selection,
        }
      }
    }
  }, [handle, data, selection, selectionAction])

  // init
  useEffect(() => {
    refTimer.current = setTimeout(queryHandle, 199)
    // React 工程渲染抖动
    return () => clearTimeout(refTimer.current)
  }, [])

  // componentDidMount
  useEffect(() => {
    mounted.current = true

    return () => { // 🚧-①
      queryCount.current = 0
      mounted.current = false
      unMounted.current = true
    }
  }, [])

  const tableProps: AntdTableProps<RecordType> = editComponents.withOnRow({
    size: 'small',
    columns: editComponents.withOnCell(columns!),
    dataSource: data,
    onChange(pagination, filters, sorter, extra) {
      onChange?.(pagination, filters, sorter, extra)

      // works without `props.query`
      // !query && setPage(pagination)

      const { current, pageSize, total } = pagination
      queryHandle({
        pagination: { current, pageSize, total },
        // use last cache
        payload: queryArgs.current?.payload,
        changes: {
          pagination,
          filters,
          // TODO: remove type assert
          sorter: sorter as Record<string, any>,
          extra: extra as TableCurrentDataSource<Record<string, any>>,
        },
      })
    },
    rowKey: (_, index) => String(index), // Expect to pass from props!
    pagination: page,
    rowSelection: isObject(props_rowSelection) ? rowSelection : undefined,
    ...rest,
  })

  return (
    <Table
      components={editable ? editComponents({ handle }) : undefined}
      loading={loading}
      {...tableProps as any}
    />
  )
}

export default TableAntd

// -----------------------------------------------------------------------------

// 🚧-②: 暂时屏蔽报错
// Warning: Cannot update a component (`InternalFormItem`) while rendering a different component (`Unknown`).

/**
 * 可编辑表格实现
 * @see https://ant.design/components/table/#components-table-demo-edit-cell
 */
function editComponents<RecordType = Record<string, any>, FormValues = Record<string, any>>(
  args: {
    handle?: TableHandle<RecordType>,
    onFieldChange?: (args: { key: string; value: any; index: number }) => void,
  },
): AntdTableProps<RecordType>['components'] {
  // 每行独立一个 FormInstance

  return {
    body: {
      row: ({
        record,
        index,

        className: CN,
        ...rest
      }: Record<string, any>) => {
        const className = CN + ' tr-form-item'

        if (typeof index === /* <thead> */'undefined') {
          return <tr className={className} {...rest} />
        }

        // TODO: 考虑支持外部传入 FormInstance 达到完全可控
        const [form] = Form.useForm(
          // 2022-10-26 如果使用缓存会在表格删除时,造成老数据滞留 BUG 🐞
          // 2022-11-02 表格删除 row 时可以根据 dataSource 长度裁剪掉多余的 forms 避开缓存问题，但即便使用了缓存并无性能优化
          // args.handle?.forms?.[index]
        )
        if (args.handle) {
          args.handle.forms ??= []
          // 抛出 FormInstance
          args.handle.forms[index] = form
          // Remove unused FormInstance
          args.handle.forms.length = index + 1
        }
        // TODO: additionalProps 在添加 rowSelection 属性后变成 undefined
        // const initialValues = (rest.children as Record<string, any>[])
        //   .map(child => child.props.additionalProps.column as TableColumn<RecordType>)
        //   .filter(column => column.formItem)
        //   /**
        //    * Expected ")" but found "as"
        //    *   at failureErrorWithLog (/node_modules/esbuild/lib/main.js:1615:15)
        //    * .map(column => column.dataIndex /* Only support string *\/ as string)
        //    */
        //   .map(column => column.dataIndex as /* Only support string */ string)
        //   .reduce((memo, key) => Object.assign(memo, { [key]: record[key] }), {})

        return (
          <Form
            form={form}
            component={false}
            // TODO: use initialValues instead record
            initialValues={record}
          >
            <tr className={className} {...rest} />
          </Form>
        )
      },
      cell: ({
        column,
        record,
        index,

        children,
        ...rest
      }: Record<string, any>) => {
        let childNode = children

        // title 列无 record
        if (record) {
          const { dataIndex, formItem } = (column || {}) as TableColumn<RecordType>
          const key = dataIndex as string

          if (formItem) {
            const {
              input: input2,
              select: select2,
              render,
              ...formItemProps
            } = formItem
            const cbArgs = {
              form: args.handle?.forms[index]!,
              record,
              index,
            }
            // 返回 void 即视为条件渲染
            const input = typeof input2 === 'function' ? input2(cbArgs) : input2
            const select = typeof select2 === 'function' ? select2(cbArgs) : select2

            // 当前列为 Form 元素，将原数据备份到 dataIndex_old 中
            const backupKey = key + '_old'
            if (!Object.keys(record).includes(backupKey)) {
              record[backupKey] = record[key]
            }

            if (render) {
              childNode = (
                <Form.Item name={key} {...formItemProps}>
                  {render(cbArgs)}
                </Form.Item>
              )
            } else if (input) {
              const { onChange, onBlur, ...restInput } = input
              childNode = (
                <Form.Item name={key} {...formItemProps}>
                  <Input
                    allowClear
                    placeholder='请输入'
                    onChange={event => {
                      onChange?.(event)
                      record[key] /* 软更新 🚧-② */ = (event.target as any).value
                    }}
                    onBlur={event => {
                      onBlur?.(event)
                      args.onFieldChange?.({ key, value: event.target.value, index }) // 硬更新
                    }}
                    {...restInput}
                  />
                </Form.Item>
              )
            } else if (select) {
              const { onChange, ...restSelect } = select
              childNode = (
                <Form.Item name={key} {...formItemProps}>
                  <Select
                    allowClear
                    showSearch
                    placeholder='请选择'
                    filterOption={(input, option) => {
                      const reg = new RegExp(input)
                      const res = (option?.label && reg.exec(option.label as string)) ||
                        (option?.value && reg.exec(option.value as string))
                      return !!res
                    }}
                    onChange={(value, option) => {
                      onChange?.(value, option)
                      record[key] /* 软更新 🚧-② */ = value
                      args.onFieldChange?.({ key, value, index }) // 硬更新
                    }}
                    {...restSelect}
                  />
                </Form.Item>
              )
            }
          }
        }

        return <td {...rest}>{childNode}</td>
      },
    },
  }
}
editComponents.withOnCell = function onCell<RecordType = Record<string, any>>(columns: TableColumn<RecordType>[]): typeof columns {
  return columns.map(column => {
    const original = column.onCell
    // 透传至 components.body.cell
    column.onCell = function onCell(record, index) {
      return {
        column,
        record,
        index,
        ...original?.(record, index)
      } as any
    }
    return column
  })
}
editComponents.withOnRow = function withOnRow<RecordType = Record<string, any>>(tableProps: TableProps<RecordType>): typeof tableProps {
  const original = tableProps.onRow
  // Passed into components.body.row
  tableProps.onRow = function onRow(record, index) {
    return { record, index, ...original?.(record, index) } as any
  }
  return tableProps
}

// -----------------------------------------------------------------------------

export function resetDataSource<RecordType = Record<string, any>>(data: Required<TableProps<RecordType>>['dataSource']) {
  return data.map(d => {
    // @ts-ignore
    const keys = Object.keys(d).filter(key => key.endsWith('_old'))
    for (const key of keys) {
      // @ts-ignore
      d[key.replace('_old', '')] = d[key]
    }
    return d
  })
}

/** Enhance Table's colum config */
export function enhanceColumn<RecordType = unknown>(tablProps: Omit<TableProps<RecordType>, 'columns'> & {
  columns: (TableColumn<RecordType> & {
    tooltip?:
    | Partial<TooltipProps>
    | ((text: any, record: RecordType, index: number) => Partial<TooltipProps>)
  })[]
  columnWidth?: number
}): typeof tablProps {
  const { columnWidth = 147 } = tablProps

  if (tablProps.columns?.length) {
    for (const column of tablProps.columns) {
      const original = column.render

      // Tooltip
      if (column.tooltip) {
        column.render = (text, record, index) => {
          const tooltip = typeof column.tooltip === 'function'
            ? column.tooltip(text, record, index)
            : column.tooltip
          const node = original?.(text, record, index) ?? text
          return (
            <Tooltip title={node} {...tooltip}>
              {/* Make sure the Tooltip box is centered. */}
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node}</div>
            </Tooltip>
          )
        }
      }

      // Assign default colum width
      column.width ??= columnWidth
    }

    // Assign default `scroll.x`
    tablProps.scroll ??= {}
    tablProps.scroll.x ??= tablProps.columns
      .reduce((memo, col) => memo + (typeof col.width === 'number' ? col.width : columnWidth), 0)
  }

  return tablProps
}
