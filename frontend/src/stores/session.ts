import { defineStore } from 'pinia'

export type OperatorRole = '设备管理员' | '值班员'

export const ROLES: OperatorRole[] = ['设备管理员', '值班员']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    // 开挖直径属于设备档案封存字段，只有设备管理员能改；值班员越权提交会在域层被挡回。
    role: '设备管理员' as OperatorRole,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canEditDiameter: (state) => state.role === '设备管理员',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole) {
      this.role = role
    },
  },
})
