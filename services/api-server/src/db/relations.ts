import { relations } from 'drizzle-orm'

import {
  // Tenant
  companies,
  masterSoffice,
  masterLini,
  masterVarian,
  // Auth
  appUsers,
  userLiniAssignments,
  absensi,
  // Customer
  masterCustomer,
  doctorProfiles,
  doctorOutletAssignments,
  masterPic,
  // Material
  masterMaterial,
  masterPrice,
  stockInventoryAtp,
  masterPromotions,
  // Visit
  visitPlans,
  visits,
  visitAgendas,
  visitStockAudits,
  visitCompetitorAudits,
  // Order
  orders,
  orderItems,
  // Audit
  auditMutationLogs,
  auditFraudTelemetry,
  auditErpSyncLogs,
  auditVisitLifecycle,
} from './schema'

// ─── Tenant Relations ────────────────────────────────────────────────────────

export const companiesRelations = relations(companies, ({ many }) => ({
  soffices: many(masterSoffice),
  linis: many(masterLini),
  varians: many(masterVarian),
  users: many(appUsers),
  userLiniAssignments: many(userLiniAssignments),
  customers: many(masterCustomer),
  doctorProfiles: many(doctorProfiles),
  doctorOutletAssignments: many(doctorOutletAssignments),
  pics: many(masterPic),
  materials: many(masterMaterial),
  prices: many(masterPrice),
  stockInventory: many(stockInventoryAtp),
  promotions: many(masterPromotions),
  visitPlans: many(visitPlans),
  visits: many(visits),
  orders: many(orders),
  absensi: many(absensi),
  auditMutationLogs: many(auditMutationLogs),
  auditFraudTelemetry: many(auditFraudTelemetry),
  auditErpSyncLogs: many(auditErpSyncLogs),
  auditVisitLifecycle: many(auditVisitLifecycle),
}))

export const masterSofficeRelations = relations(masterSoffice, ({ one, many }) => ({
  company: one(companies, {
    fields: [masterSoffice.companyId],
    references: [companies.id],
  }),
  users: many(appUsers),
  customers: many(masterCustomer),
  prices: many(masterPrice),
  stockInventory: many(stockInventoryAtp),
  orders: many(orders),
}))

export const masterLiniRelations = relations(masterLini, ({ one, many }) => ({
  company: one(companies, {
    fields: [masterLini.companyId],
    references: [companies.id],
  }),
  userLiniAssignments: many(userLiniAssignments),
  materials: many(masterMaterial),
}))

export const masterVarianRelations = relations(masterVarian, ({ one, many }) => ({
  company: one(companies, {
    fields: [masterVarian.companyId],
    references: [companies.id],
  }),
  prices: many(masterPrice),
  stockInventory: many(stockInventoryAtp),
}))

// ─── Auth Relations ──────────────────────────────────────────────────────────

export const appUsersRelations = relations(appUsers, ({ one, many }) => ({
  company: one(companies, {
    fields: [appUsers.companyId],
    references: [companies.id],
  }),
  soffice: one(masterSoffice, {
    fields: [appUsers.sofficeId],
    references: [masterSoffice.id],
  }),
  liniAssignments: many(userLiniAssignments),
  visitPlans: many(visitPlans),
  visits: many(visits),
  orders: many(orders),
  absensi: many(absensi),
  auditMutationLogs: many(auditMutationLogs),
  auditFraudTelemetry: many(auditFraudTelemetry),
  auditVisitLifecycle: many(auditVisitLifecycle),
}))

export const userLiniAssignmentsRelations = relations(userLiniAssignments, ({ one }) => ({
  company: one(companies, {
    fields: [userLiniAssignments.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [userLiniAssignments.userId],
    references: [appUsers.id],
  }),
  lini: one(masterLini, {
    fields: [userLiniAssignments.liniId],
    references: [masterLini.id],
  }),
}))

export const absensiRelations = relations(absensi, ({ one }) => ({
  company: one(companies, {
    fields: [absensi.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [absensi.userId],
    references: [appUsers.id],
  }),
}))

// ─── Customer Relations ──────────────────────────────────────────────────────

export const masterCustomerRelations = relations(masterCustomer, ({ one, many }) => ({
  company: one(companies, {
    fields: [masterCustomer.companyId],
    references: [companies.id],
  }),
  soffice: one(masterSoffice, {
    fields: [masterCustomer.sofficeId],
    references: [masterSoffice.id],
  }),
  doctorProfile: one(doctorProfiles),
  pics: many(masterPic),
  doctorAssignmentsAsDoctor: many(doctorOutletAssignments, {
    relationName: 'doctorCustomer',
  }),
  doctorAssignmentsAsOutlet: many(doctorOutletAssignments, {
    relationName: 'outletCustomer',
  }),
  visitPlansAsCustomer: many(visitPlans, {
    relationName: 'planCustomer',
  }),
  visitPlansAsOutletContext: many(visitPlans, {
    relationName: 'planOutletContext',
  }),
  visitsAsCustomer: many(visits, {
    relationName: 'visitCustomer',
  }),
  visitsAsOutlet: many(visits, {
    relationName: 'visitOutlet',
  }),
  ordersAsCustomer: many(orders, {
    relationName: 'orderCustomer',
  }),
  ordersAsDoctor: many(orders, {
    relationName: 'orderDoctor',
  }),
}))

export const doctorProfilesRelations = relations(doctorProfiles, ({ one }) => ({
  company: one(companies, {
    fields: [doctorProfiles.companyId],
    references: [companies.id],
  }),
  customer: one(masterCustomer, {
    fields: [doctorProfiles.customerId],
    references: [masterCustomer.id],
  }),
}))

export const doctorOutletAssignmentsRelations = relations(doctorOutletAssignments, ({ one }) => ({
  company: one(companies, {
    fields: [doctorOutletAssignments.companyId],
    references: [companies.id],
  }),
  doctor: one(masterCustomer, {
    fields: [doctorOutletAssignments.doctorCustomerId],
    references: [masterCustomer.id],
    relationName: 'doctorCustomer',
  }),
  outlet: one(masterCustomer, {
    fields: [doctorOutletAssignments.outletCustomerId],
    references: [masterCustomer.id],
    relationName: 'outletCustomer',
  }),
}))

export const masterPicRelations = relations(masterPic, ({ one }) => ({
  company: one(companies, {
    fields: [masterPic.companyId],
    references: [companies.id],
  }),
  customer: one(masterCustomer, {
    fields: [masterPic.customerId],
    references: [masterCustomer.id],
  }),
}))

// ─── Material Relations ──────────────────────────────────────────────────────

export const masterMaterialRelations = relations(masterMaterial, ({ one, many }) => ({
  company: one(companies, {
    fields: [masterMaterial.companyId],
    references: [companies.id],
  }),
  lini: one(masterLini, {
    fields: [masterMaterial.liniId],
    references: [masterLini.id],
  }),
  prices: many(masterPrice),
  stockInventory: many(stockInventoryAtp),
  orderItems: many(orderItems),
  visitAgendas: many(visitAgendas),
  visitStockAudits: many(visitStockAudits),
}))

export const masterPriceRelations = relations(masterPrice, ({ one }) => ({
  company: one(companies, {
    fields: [masterPrice.companyId],
    references: [companies.id],
  }),
  soffice: one(masterSoffice, {
    fields: [masterPrice.sofficeId],
    references: [masterSoffice.id],
  }),
  material: one(masterMaterial, {
    fields: [masterPrice.materialId],
    references: [masterMaterial.id],
  }),
  varian: one(masterVarian, {
    fields: [masterPrice.varianId],
    references: [masterVarian.id],
  }),
}))

export const stockInventoryAtpRelations = relations(stockInventoryAtp, ({ one }) => ({
  company: one(companies, {
    fields: [stockInventoryAtp.companyId],
    references: [companies.id],
  }),
  soffice: one(masterSoffice, {
    fields: [stockInventoryAtp.sofficeId],
    references: [masterSoffice.id],
  }),
  material: one(masterMaterial, {
    fields: [stockInventoryAtp.materialId],
    references: [masterMaterial.id],
  }),
  varian: one(masterVarian, {
    fields: [stockInventoryAtp.varianId],
    references: [masterVarian.id],
  }),
}))

export const masterPromotionsRelations = relations(masterPromotions, ({ one }) => ({
  company: one(companies, {
    fields: [masterPromotions.companyId],
    references: [companies.id],
  }),
  freeMaterial: one(masterMaterial, {
    fields: [masterPromotions.freeMaterialId],
    references: [masterMaterial.id],
  }),
}))

// ─── Visit Relations ─────────────────────────────────────────────────────────

export const visitPlansRelations = relations(visitPlans, ({ one }) => ({
  company: one(companies, {
    fields: [visitPlans.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [visitPlans.userId],
    references: [appUsers.id],
  }),
  customer: one(masterCustomer, {
    fields: [visitPlans.customerId],
    references: [masterCustomer.id],
    relationName: 'planCustomer',
  }),
  outletContext: one(masterCustomer, {
    fields: [visitPlans.outletContextId],
    references: [masterCustomer.id],
    relationName: 'planOutletContext',
  }),
}))

export const visitsRelations = relations(visits, ({ one, many }) => ({
  company: one(companies, {
    fields: [visits.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [visits.userId],
    references: [appUsers.id],
  }),
  customer: one(masterCustomer, {
    fields: [visits.customerId],
    references: [masterCustomer.id],
    relationName: 'visitCustomer',
  }),
  outlet: one(masterCustomer, {
    fields: [visits.outletId],
    references: [masterCustomer.id],
    relationName: 'visitOutlet',
  }),
  pic: one(masterPic, {
    fields: [visits.picId],
    references: [masterPic.id],
  }),
  agendas: many(visitAgendas),
  stockAudits: many(visitStockAudits),
  competitorAudits: many(visitCompetitorAudits),
  orders: many(orders),
  lifecycleAudits: many(auditVisitLifecycle),
}))

export const visitAgendasRelations = relations(visitAgendas, ({ one }) => ({
  visit: one(visits, {
    fields: [visitAgendas.visitId],
    references: [visits.id],
  }),
  productDiscussed: one(masterMaterial, {
    fields: [visitAgendas.productDiscussedId],
    references: [masterMaterial.id],
  }),
}))

export const visitStockAuditsRelations = relations(visitStockAudits, ({ one }) => ({
  visit: one(visits, {
    fields: [visitStockAudits.visitId],
    references: [visits.id],
  }),
  material: one(masterMaterial, {
    fields: [visitStockAudits.materialId],
    references: [masterMaterial.id],
  }),
}))

export const visitCompetitorAuditsRelations = relations(visitCompetitorAudits, ({ one }) => ({
  visit: one(visits, {
    fields: [visitCompetitorAudits.visitId],
    references: [visits.id],
  }),
}))

// ─── Order Relations ─────────────────────────────────────────────────────────

export const ordersRelations = relations(orders, ({ one, many }) => ({
  company: one(companies, {
    fields: [orders.companyId],
    references: [companies.id],
  }),
  soffice: one(masterSoffice, {
    fields: [orders.sofficeId],
    references: [masterSoffice.id],
  }),
  user: one(appUsers, {
    fields: [orders.userId],
    references: [appUsers.id],
  }),
  customer: one(masterCustomer, {
    fields: [orders.customerId],
    references: [masterCustomer.id],
    relationName: 'orderCustomer',
  }),
  doctor: one(masterCustomer, {
    fields: [orders.doctorCustomerId],
    references: [masterCustomer.id],
    relationName: 'orderDoctor',
  }),
  visit: one(visits, {
    fields: [orders.visitId],
    references: [visits.id],
  }),
  items: many(orderItems),
}))

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  material: one(masterMaterial, {
    fields: [orderItems.materialId],
    references: [masterMaterial.id],
  }),
  promotion: one(masterPromotions, {
    fields: [orderItems.promotionId],
    references: [masterPromotions.id],
  }),
}))

// ─── Audit Relations ─────────────────────────────────────────────────────────

export const auditMutationLogsRelations = relations(auditMutationLogs, ({ one }) => ({
  company: one(companies, {
    fields: [auditMutationLogs.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [auditMutationLogs.userId],
    references: [appUsers.id],
  }),
}))

export const auditFraudTelemetryRelations = relations(auditFraudTelemetry, ({ one }) => ({
  company: one(companies, {
    fields: [auditFraudTelemetry.companyId],
    references: [companies.id],
  }),
  user: one(appUsers, {
    fields: [auditFraudTelemetry.userId],
    references: [appUsers.id],
  }),
}))

export const auditErpSyncLogsRelations = relations(auditErpSyncLogs, ({ one }) => ({
  company: one(companies, {
    fields: [auditErpSyncLogs.companyId],
    references: [companies.id],
  }),
}))

export const auditVisitLifecycleRelations = relations(auditVisitLifecycle, ({ one }) => ({
  company: one(companies, {
    fields: [auditVisitLifecycle.companyId],
    references: [companies.id],
  }),
  visit: one(visits, {
    fields: [auditVisitLifecycle.visitId],
    references: [visits.id],
  }),
  user: one(appUsers, {
    fields: [auditVisitLifecycle.userId],
    references: [appUsers.id],
  }),
}))
