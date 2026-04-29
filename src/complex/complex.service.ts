import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Types, Connection } from 'mongoose';
import { Complex } from '../database/schemas/complex.schema';
import {
  CreateComplexDto,
  UpdateComplexDto,
  SetupBusinessProfileDto,
} from './dto/create-complex.dto';
import { ListComplexesQueryDto } from './dto/list-complexes-query.dto';
import { UpdateComplexStatusDto } from './dto/update-complex-status.dto';
import { ValidationUtil } from '../common/utils/validation.util';
import { TransactionUtil } from '../common/utils/transaction.util';
import { SubscriptionService } from '../subscription/subscription.service';
import { DepartmentService } from '../department/department.service';
import {
  AssignedClinicSummary,
  CapacityBreakdown,
  DoctorStaffSummary,
  DepartmentRestriction,
  PaginatedResponse,
  StatusChangeResponse,
} from './interfaces/complex-responses.interface';
import { ERROR_CODES } from './constants/error-codes.constant';

@Injectable()
export class ComplexService {
  constructor(
    @InjectModel('Complex') private readonly complexModel: Model<Complex>,
    @InjectConnection() private readonly connection: Connection,
    private readonly subscriptionService: SubscriptionService,
    private readonly departmentService: DepartmentService,
  ) { }

  private buildSubscriptionMatch(subscriptionId?: string): any {
    if (!subscriptionId) return undefined;
    if (!Types.ObjectId.isValid(subscriptionId)) {
      return subscriptionId;
    }
    return { $in: [new Types.ObjectId(subscriptionId), subscriptionId] };
  }

  private buildImplicitOrganizationVisibilityFilter(organizationId?: string): any[] {
    if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
      return [];
    }

    return [
      { organizationId: new Types.ObjectId(organizationId) },
      { organizationId: null },
      { organizationId: { $exists: false } },
    ];
  }

  /**
   * List complexes with pagination, filters, and optional counts
   *
   * @param query - Query parameters for filtering, sorting, and pagination
   * @param requestingUser - The user making the request
   * @returns Promise<PaginatedResponse<Complex>> - Paginated list of complexes
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
   */
  async listComplexes(
    query: ListComplexesQueryDto,
    requestingUser?: any,
  ): Promise<PaginatedResponse<any>> {
    // Build query filters
    const filter: any = {};

    let targetSubscriptionId = query.subscriptionId;
    let targetOrganizationId = query.organizationId;
    let scopedComplexIds: Types.ObjectId[] | null = null;

    // TENANT ISOLATION (ISSUE-009)
    if (requestingUser && requestingUser.role !== 'super_admin') {
      const requestingRole = String(requestingUser.role || '').toLowerCase();

      if (requestingUser.subscriptionId) {
        targetSubscriptionId = requestingUser.subscriptionId;
      }

      // Assignment scoping for non-admin roles
      if (requestingRole === 'doctor' || requestingRole === 'staff') {
        const allowedComplexIds = new Set<string>();

        const directComplexId = requestingUser.complexId?.toString?.() ?? requestingUser.complexId;
        if (directComplexId && Types.ObjectId.isValid(directComplexId)) {
          allowedComplexIds.add(directComplexId.toString());
        }

        const clinicIdCandidates = new Set<string>();
        const directClinicId = requestingUser.clinicId?.toString?.() ?? requestingUser.clinicId;
        if (directClinicId && Types.ObjectId.isValid(directClinicId)) {
          clinicIdCandidates.add(directClinicId.toString());
        }
        if (Array.isArray(requestingUser.clinicIds)) {
          for (const clinicId of requestingUser.clinicIds) {
            const candidate = clinicId?.toString?.() ?? clinicId;
            if (candidate && Types.ObjectId.isValid(candidate)) {
              clinicIdCandidates.add(candidate.toString());
            }
          }
        }

        if (clinicIdCandidates.size > 0) {
          const clinics = await this.complexModel.db
            .collection('clinics')
            .find(
              { _id: { $in: Array.from(clinicIdCandidates).map((id) => new Types.ObjectId(id)) } },
              { projection: { complexId: 1 } },
            )
            .toArray();

          for (const clinic of clinics) {
            const complexId = clinic?.complexId?.toString?.();
            if (complexId && Types.ObjectId.isValid(complexId)) {
              allowedComplexIds.add(complexId);
            }
          }
        }

        scopedComplexIds = Array.from(allowedComplexIds).map(
          (id) => new Types.ObjectId(id),
        );
      }
    }

    // Exclude soft-deleted complexes
    filter.deletedAt = null;

    // Filter by organizationId
    if (targetOrganizationId) {
      filter.organizationId = new Types.ObjectId(targetOrganizationId);
    } else if (requestingUser?.role !== 'super_admin') {
      const implicitOrganizationFilter =
        this.buildImplicitOrganizationVisibilityFilter(
          requestingUser?.organizationId,
        );
      if (implicitOrganizationFilter.length > 0) {
        filter.$or = implicitOrganizationFilter;
      }
    }

    // Filter by subscriptionId
    if (targetSubscriptionId) {
      filter.subscriptionId = this.buildSubscriptionMatch(targetSubscriptionId);
    }

    if (scopedComplexIds !== null) {
      filter._id = { $in: scopedComplexIds };
    }

    // Status visibility:
    // - explicit query.status always wins
    // - admin/owner/super_admin can see both active/inactive by default
    // - other roles default to active only
    const canSeeInactiveByDefault = ['super_admin', 'owner', 'admin'].includes(
      String(requestingUser?.role || '').toLowerCase(),
    );
    if (query.status) {
      filter.status = query.status;
    } else if (!canSeeInactiveByDefault) {
      filter.status = 'active';
    }

    // Search by name (case-insensitive)
    if (query.search) {
      filter.name = { $regex: new RegExp(query.search, 'i') };
    }

    // Calculate pagination
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    // Build sort object
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;
    const sort: any = { [sortBy]: sortOrder };

    // Execute query with pagination and sorting
    const complexes = await this.complexModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('personInChargeId', 'firstName lastName email role')
      .lean()
      .exec();

    // Get total count for pagination metadata
    const total = await this.complexModel.countDocuments(filter).exec();
    const totalPages = Math.ceil(total / limit);

    // If includeCounts is true, calculate metrics for each complex using aggregation
    let enrichedComplexes = complexes;
    if (query.includeCounts) {
      // Get all complex IDs for batch processing
      const complexIds = complexes.map((c) => c._id);

      // Use aggregation to calculate counts efficiently
      const [clinicCounts, appointmentCounts] = await Promise.all([
        // Aggregate clinic counts per complex
        this.complexModel.db
          .collection('clinics')
          .aggregate([
            {
              $match: {
                complexId: { $in: complexIds },
                isActive: true,
                deletedAt: null,
              },
            },
            {
              $group: {
                _id: '$complexId',
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),

        // Aggregate appointment counts per complex (via clinics)
        this.complexModel.db
          .collection('clinics')
          .aggregate([
            {
              $match: {
                complexId: { $in: complexIds },
                isActive: true,
                deletedAt: null,
              },
            },
            {
              $lookup: {
                from: 'appointments',
                let: { clinicId: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$clinicId', '$$clinicId'] },
                      status: { $in: ['scheduled', 'confirmed'] },
                      deletedAt: null,
                    },
                  },
                ],
                as: 'appointments',
              },
            },
            {
              $group: {
                _id: '$complexId',
                count: { $sum: { $size: '$appointments' } },
              },
            },
          ])
          .toArray(),
      ]);

      // Create lookup maps for O(1) access
      const clinicCountMap = new Map(
        clinicCounts.map((item) => [item._id.toString(), item.count]),
      );
      const appointmentCountMap = new Map(
        appointmentCounts.map((item) => [item._id.toString(), item.count]),
      );

      // Enrich complexes with counts and capacity
      enrichedComplexes = await Promise.all(
        complexes.map(async (complex) => {
          const complexId = complex._id.toString();

          // Get counts from maps (O(1) lookup)
          const scheduledAppointmentsCount =
            appointmentCountMap.get(complexId) || 0;
          const clinicsAssignedCount = clinicCountMap.get(complexId) || 0;

          // Calculate capacity breakdown (still needs individual calculation due to complexity)
          const capacity = await this.calculateCapacity(complexId);

          return {
            ...complex,
            scheduledAppointmentsCount,
            clinicsAssignedCount,
            capacity,
          };
        }),
      );
    }

    // Return paginated response with bilingual success message
    return {
      success: true,
      data: enrichedComplexes,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
      message: {
        ar: 'تم استرجاع قائمة المجمعات بنجاح',
        en: 'Complexes list retrieved successfully',
      },
    };
  }

  async createComplex(createComplexDto: CreateComplexDto, requestingUser?: any): Promise<any> {
    // TENANT ISOLATION (ISSUE-009)
    if (requestingUser && requestingUser.role !== 'super_admin') {
      if (requestingUser.subscriptionId && createComplexDto.subscriptionId !== requestingUser.subscriptionId) {
        throw new ForbiddenException({
          message: {
            ar: 'ليس لديك صلاحية لإنشاء مجمع لهذا الاشتراك',
            en: 'You do not have permission to create complex for this subscription',
          },
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    }

    // Validate subscription is active
    const isActive = await this.subscriptionService.isSubscriptionActive(
      createComplexDto.subscriptionId,
    );
    if (!isActive) {
      throw new BadRequestException({
        code: 'COMPLEX_008',
        message: ERROR_CODES.COMPLEX_008.message,
      });
    }

    // Validate subscription limits
    const currentComplexes = await this.complexModel.countDocuments({
      subscriptionId: this.buildSubscriptionMatch(
        createComplexDto.subscriptionId,
      ),
    });

    const { plan } = await this.subscriptionService.getSubscriptionWithPlan(
      createComplexDto.subscriptionId,
    );
    if (
      plan.maxComplexes &&
      plan.maxComplexes > 0 &&
      currentComplexes >= plan.maxComplexes
    ) {
      throw new BadRequestException({
        code: 'COMPLEX_001',
        message: ERROR_CODES.COMPLEX_001.message,
      });
    }
    const isNameAvailable = await this.isNameAvailable(
      createComplexDto.name,
      createComplexDto.organizationId,
    );
    if (!isNameAvailable) {
      throw new BadRequestException({
        message: {
          ar: 'اسم المجمع مستخدم بالفعل، يرجى اختيار اسم آخر',
          en: 'Complex name already exists, please choose a different name',
        },
        code: 'COMPLEX_NAME_TAKEN',
      });
    }

    // Validate business profile for complex-only plans
    if (!createComplexDto.organizationId) {
      const businessProfileValidation = ValidationUtil.validateBusinessProfile({
        yearEstablished: createComplexDto.yearEstablished,
        mission: createComplexDto.mission,
        vision: createComplexDto.vision,
        ceoName: createComplexDto.ceoName,
        vatNumber: createComplexDto.vatNumber,
        crNumber: createComplexDto.crNumber,
      });

      if (!businessProfileValidation.isValid) {
        throw new BadRequestException({
          message: {
            ar: `فشل التحقق: ${businessProfileValidation.errors.join(', ')}`,
            en: `Validation failed: ${businessProfileValidation.errors.join(', ')}`,
          },
        });
      }
    }

    // Validate contact information
    if (
      createComplexDto.email &&
      !ValidationUtil.validateEmail(createComplexDto.email)
    ) {
      throw new BadRequestException({
        code: 'COMPLEX_009',
        message: ERROR_CODES.COMPLEX_009.message,
      });
    }

    const normalizedCreateLegacyPhone = this.normalizePhoneValue(
      createComplexDto.phone,
    );
    if (
      normalizedCreateLegacyPhone &&
      !ValidationUtil.validatePhone(normalizedCreateLegacyPhone)
    ) {
      throw new BadRequestException({
        code: 'COMPLEX_010',
        message: ERROR_CODES.COMPLEX_010.message,
      });
    }

    const normalizedCreatePhoneNumbers = this.normalizePhoneNumbers(
      (createComplexDto as any).phone,
      (createComplexDto as any).phoneNumbers,
    );
    if (
      normalizedCreatePhoneNumbers.some(
        (entry) => !ValidationUtil.validatePhone(entry.number),
      )
    ) {
      throw new BadRequestException({
        code: 'COMPLEX_010',
        message: ERROR_CODES.COMPLEX_010.message,
      });
    }

    const {
      phone,
      googleLocation,
      departmentIds: createDepartmentIds,
      newDepartmentNames,
      ...restDto
    } = createComplexDto as any;

    const complexData: any = {
      ...restDto,
      organizationId: createComplexDto.organizationId
        ? new Types.ObjectId(createComplexDto.organizationId)
        : null,
      subscriptionId: new Types.ObjectId(createComplexDto.subscriptionId),
      ownerId: new Types.ObjectId(createComplexDto.ownerId),
      status: 'active',
    };

    if (normalizedCreatePhoneNumbers.length > 0) {
      complexData.phoneNumbers = normalizedCreatePhoneNumbers;
    }

    if (googleLocation) {
      complexData.address = {
        ...(complexData.address || {}),
        googleLocation,
      };
    }

    // Create the complex first to get its ID
    const complex = new this.complexModel(complexData);
    const savedComplex = await complex.save();

    // Validate personInChargeId if provided (after complex is created)
    if (createComplexDto.personInChargeId) {
      const isValid = await this.validatePersonInCharge(
        createComplexDto.personInChargeId,
        (savedComplex._id as Types.ObjectId).toString(),
      );

      if (!isValid) {
        // Delete the complex if PIC validation fails
        await this.complexModel.findByIdAndDelete(savedComplex._id);
        throw new BadRequestException({
          code: 'COMPLEX_002',
          message: ERROR_CODES.COMPLEX_002.message,
        });
      }

      // Update the complex with personInChargeId
      savedComplex.personInChargeId = new Types.ObjectId(
        createComplexDto.personInChargeId,
      );
      await savedComplex.save();
    }

    // Link departments to this complex if provided
    if (createDepartmentIds && createDepartmentIds.length > 0) {
      await this.complexModel.db.collection('complex_departments').insertMany(
        createDepartmentIds.map((departmentId: string) => ({
          complexId: savedComplex._id,
          departmentId: new Types.ObjectId(departmentId),
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    }

    // Create new departments by name and link them to this complex
    if (newDepartmentNames && newDepartmentNames.length > 0) {
      const allExisting = await this.departmentService.getAllDepartments();
      for (const rawName of newDepartmentNames) {
        const nameTrimmed = rawName.trim();
        if (!nameTrimmed) continue;
        let dept = allExisting.find(
          (d: any) => d.name.toLowerCase() === nameTrimmed.toLowerCase(),
        );
        if (!dept) {
          dept = await this.departmentService.createDepartment({
            name: nameTrimmed,
            description: `Department for ${savedComplex.name}`,
          });
        }
        await this.departmentService.createComplexDepartment(
          (savedComplex._id as Types.ObjectId).toString(),
          (dept._id as any).toString(),
        );
      }
    }

    // Populate relationships in response
    const populatedComplex = await this.complexModel
      .findById(savedComplex._id)
      .populate('organizationId', 'name email phone address')
      .populate('subscriptionId', 'planId startDate endDate status')
      .populate('ownerId', 'firstName lastName email role')
      .populate('personInChargeId', 'firstName lastName email role')
      .exec();

    if (!populatedComplex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // Fetch linked departments for response (includes both existing IDs and newly created ones)
    const departments = (createDepartmentIds?.length || newDepartmentNames?.length)
      ? await this.complexModel.db
          .collection('complex_departments')
          .aggregate([
            { $match: { complexId: savedComplex._id, isActive: true } },
            {
              $lookup: {
                from: 'departments',
                localField: 'departmentId',
                foreignField: '_id',
                as: 'department',
              },
            },
            { $unwind: '$department' },
            { $replaceRoot: { newRoot: '$department' } },
          ])
          .toArray()
      : [];

    return {
      ...(populatedComplex as any).toObject(),
      departments,
    };
  }

  /**
   * Get complete complex details with all relationships and calculated metrics
   *
   * @param complexId - The complex ID
   * @param requestingUser - The user making the request
   * @returns Promise<ComplexDetailsResponse> - Complete complex details
   *
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
   */
  async getComplexDetails(complexId: string, requestingUser?: any): Promise<any> {
    // Query complex by ID with all relationships populated
    const complex = await this.complexModel
      .findById(complexId)
      .populate('organizationId', 'name email phone address')
      .populate('subscriptionId', 'planId startDate endDate status')
      .populate('ownerId', 'firstName lastName email role')
      .populate('personInChargeId', 'firstName lastName email role')
      .exec();

    // Handle not found with bilingual error
    if (!complex) {
      throw new NotFoundException({
        code: ERROR_CODES.COMPLEX_006.code,
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    // Note: ownerId, subscriptionId, organizationId are populated objects at this point,
    // so we must extract _id from them instead of calling .toString() directly.
    if (requestingUser && requestingUser.role !== 'super_admin') {
      const complexSubscriptionId =
        (complex.subscriptionId as any)?._id?.toString() ??
        complex.subscriptionId?.toString();

      const complexOrganizationId =
        (complex.organizationId as any)?._id?.toString() ??
        complex.organizationId?.toString();

      const complexOwnerId =
        (complex.ownerId as any)?._id?.toString() ??
        complex.ownerId?.toString();

      const requestingUserId = requestingUser.userId || requestingUser.sub;
      const requestingRole = String(requestingUser.role || '').toLowerCase();
      const requestingComplexId =
        requestingUser.complexId?.toString?.() ??
        requestingUser.complexId ??
        null;
      const currentComplexId =
        (complex as any)?._id?.toString?.() ??
        (complex as any)?._id ??
        null;

      const subscriptionMatch =
        !requestingUser.subscriptionId ||
        complexSubscriptionId === requestingUser.subscriptionId;

      const organizationMatch =
        !!requestingUser.organizationId &&
        complexOrganizationId === requestingUser.organizationId;

      const isOwnerOfComplex = complexOwnerId === requestingUserId;
      if (requestingRole === 'doctor' || requestingRole === 'staff') {
        let isAssignedDoctorOrStaff =
          !!requestingComplexId &&
          !!currentComplexId &&
          currentComplexId.toString() === requestingComplexId.toString();

        if (!isAssignedDoctorOrStaff && currentComplexId && Array.isArray(requestingUser.clinicIds) && requestingUser.clinicIds.length > 0) {
          const assignedClinicIds = requestingUser.clinicIds
            .map((id: any) => id?.toString?.() ?? id)
            .filter((id: string) => Types.ObjectId.isValid(id))
            .map((id: string) => new Types.ObjectId(id));

          if (assignedClinicIds.length > 0) {
            const matchedClinic = await this.complexModel.db
              .collection('clinics')
              .findOne(
                {
                  _id: { $in: assignedClinicIds },
                  complexId: new Types.ObjectId(currentComplexId),
                },
                { projection: { _id: 1 } },
              );
            isAssignedDoctorOrStaff = !!matchedClinic;
          }
        }

        if (!subscriptionMatch || !isAssignedDoctorOrStaff) {
          throw new ForbiddenException({
            message: {
              ar: 'ليس لديك صلاحية للوصول إلى هذا المجمع',
              en: 'You do not have permission to access this complex',
            },
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }
      } else if (!subscriptionMatch && !organizationMatch && !isOwnerOfComplex) {
        throw new ForbiddenException({
          message: {
            ar: 'ليس لديك صلاحية للوصول إلى هذا المجمع',
            en: 'You do not have permission to access this complex',
          },
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    }

    // Calculate scheduled appointments count
    const scheduledAppointmentsCount =
      await this.calculateScheduledAppointments(complexId);

    // Calculate clinics assigned count
    const clinicsAssignedCount = await this.calculateClinicsAssigned(complexId);

    const [departments, capacity, assignedClinics, doctorStaffList, workingHours] =
      await Promise.all([
        this.complexModel.db
          .collection('complex_departments')
          .aggregate([
            {
              $match: {
                complexId: new Types.ObjectId(complexId),
                isActive: true,
              },
            },
            {
              $lookup: {
                from: 'departments',
                localField: 'departmentId',
                foreignField: '_id',
                as: 'department',
              },
            },
            { $unwind: '$department' },
            { $replaceRoot: { newRoot: '$department' } },
          ])
          .toArray(),
        this.calculateCapacity(complexId),
        this.getAssignedClinicList(complexId),
        this.getDoctorAndStaffList(complexId),
        this.complexModel.db
          .collection('working_hours')
          .find({
            entityType: 'complex',
            entityId: new Types.ObjectId(complexId),
            isActive: true,
          })
          .toArray(),
      ]);

    const dayOrder = [
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ];
    const sortedWorkingHours = workingHours.sort((a: any, b: any) => {
      return dayOrder.indexOf(a.dayOfWeek) - dayOrder.indexOf(b.dayOfWeek);
    });

    // Build ComplexDetailsResponse
    return {
      success: true,
      data: {
        ...complex.toObject(),
        organization: complex.organizationId,
        subscription: complex.subscriptionId,
        owner: complex.ownerId,
        personInCharge: complex.personInChargeId,
        scheduledAppointmentsCount,
        clinicsAssignedCount,
        departmentsCount: departments.length,
        departments,
        schedule: sortedWorkingHours,
        workingHours: sortedWorkingHours,
        capacity,
        assignedClinics,
        doctorStaffList,
      },
      message: {
        ar: 'تم استرجاع تفاصيل المجمع بنجاح',
        en: 'Complex details retrieved successfully',
      },
    };
  }

  /**
   * Get complex by ID (simple version for internal use)
   * Used by update and setup methods
   *
   * @param complexId - The complex ID
   * @returns Promise<Complex> - Complex document
   */
  private async getComplex(complexId: string): Promise<Complex> {
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }
    return complex;
  }

  async getComplexesForDropdown(requestingUser?: any): Promise<any> {
    const filter: any = { deletedAt: null, status: 'active' };

    // TENANT ISOLATION (ISSUE-009)
    if (requestingUser && requestingUser.role !== 'super_admin') {
      if (requestingUser.subscriptionId) {
        filter.subscriptionId = this.buildSubscriptionMatch(
          requestingUser.subscriptionId.toString(),
        );
      }

      const implicitOrganizationFilter =
        this.buildImplicitOrganizationVisibilityFilter(
          requestingUser.organizationId,
        );
      if (implicitOrganizationFilter.length > 0) {
        filter.$or = implicitOrganizationFilter;
      }
    }

    const complexes = await this.complexModel
      .find(filter)
      .select('_id name')
      .sort({ name: 1 })
      .lean()
      .exec();

    return {
      success: true,
      data: complexes,
      message: {
        ar: 'تم استرجاع قائمة المجمعات بنجاح',
        en: 'Complexes retrieved successfully',
      },
    };
  }

  /**
   * Get the complex assigned to the requesting user (Doctor/Staff)
   * Perm #21: View Assigned Complex
   */
  async getAssignedComplex(requestingUser: any): Promise<any> {
    if (!requestingUser?.complexId) {
      throw new NotFoundException({
        message: {
          ar: 'لا يوجد مجمع معين لهذا المستخدم',
          en: 'No complex is assigned to this user',
        },
        code: 'COMPLEX_007',
      });
    }

    const complexId = requestingUser.complexId.toString();

    if (!Types.ObjectId.isValid(complexId)) {
      throw new NotFoundException({
        message: { ar: 'معرف المجمع غير صالح', en: 'Invalid complex ID' },
        code: 'COMPLEX_008',
      });
    }

    const complex = await this.complexModel
      .findOne({ _id: new Types.ObjectId(complexId), deletedAt: null })
      .lean()
      .exec();

    if (!complex) {
      throw new NotFoundException({
        message: { ar: 'المجمع غير موجود', en: 'Assigned complex not found' },
        code: 'COMPLEX_006',
      });
    }

    return {
      success: true,
      message: { ar: 'تم استرجاع المجمع بنجاح', en: 'Assigned complex retrieved successfully' },
      data: complex,
    };
  }

  async getComplexesByOrganization(organizationId: string, requestingUser?: any): Promise<Complex[]> {
    let targetOrganizationId = organizationId;

    // TENANT ISOLATION
    if (requestingUser && requestingUser.role !== 'super_admin') {
      if (requestingUser.organizationId && organizationId !== requestingUser.organizationId) {
        throw new ForbiddenException({
          message: {
            ar: 'ليس لديك صلاحية للوصول إلى مجمعات هذه المنظمة',
            en: 'You do not have permission to access complexes for this organization',
          },
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    }

    return await this.complexModel
      .find({ organizationId: new Types.ObjectId(targetOrganizationId) })
      .exec();
  }

  async getComplexBySubscription(
    subscriptionId: string,
    requestingUser?: any,
  ): Promise<Complex | null> {
    // TENANT ISOLATION
    if (requestingUser && requestingUser.role !== 'super_admin') {
      if (requestingUser.subscriptionId && subscriptionId !== requestingUser.subscriptionId) {
        throw new ForbiddenException({
          message: {
            ar: 'ليس لديك صلاحية للوصول إلى مجمع هذا الاشتراك',
            en: 'You do not have permission to access complex for this subscription',
          },
          code: 'INSUFFICIENT_PERMISSIONS',
        });
      }
    }

    return await this.complexModel
      .findOne({ subscriptionId: this.buildSubscriptionMatch(subscriptionId) })
      .exec();
  }

  /**
   * Update complex with validation for department restrictions and PIC
   *
   * @param complexId - The complex ID
   * @param updateComplexDto - Update data
   * @param requestingUser - The user making the request
   * @returns Promise<UpdateComplexResponse> - Updated complex with restrictions if any
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8
   */
  async updateComplex(
    complexId: string,
    updateComplexDto: UpdateComplexDto,
    requestingUser?: any,
  ): Promise<any> {
    // Validate complex exists (Requirement 4.1)
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await this.verifyComplexOwnership(complex, requestingUser);

    // Check department restrictions if departmentIds are being updated (Requirements 4.2, 4.3, 4.4)
    let departmentRestrictions: DepartmentRestriction[] | undefined;
    let currentDepartmentIds: string[] = [];
    if (updateComplexDto.departmentIds != null) {
      // Get current department IDs from complex_departments
      const currentComplexDepartments = await this.complexModel.db
        .collection('complex_departments')
        .find({
          complexId: new Types.ObjectId(complexId),
          isActive: true,
        })
        .toArray();

      currentDepartmentIds = (currentComplexDepartments ?? [])
        .filter((cd) => cd.departmentId != null)
        .map((cd) => cd.departmentId.toString());

      // Find departments being removed (in current but not in new)
      const newIds = (updateComplexDto.departmentIds ?? []) as string[];
      const removedDepartmentIds = currentDepartmentIds.filter(
        (id) => !newIds.includes(id),
      );

      // Check if any removed departments are linked to active clinics
      if (removedDepartmentIds.length > 0) {
        departmentRestrictions = await this.checkDepartmentRestrictions(
          complexId,
          removedDepartmentIds,
        );

        // If there are restrictions, prevent the update and return error (Requirement 4.4)
        if (departmentRestrictions.length > 0) {
          throw new BadRequestException({
            code: 'COMPLEX_007',
            message: ERROR_CODES.COMPLEX_007.message,
            departmentRestrictions,
          });
        }
      }
    }

    // Validate personInChargeId if provided (Requirements 4.5, 8.2, 8.3)
    if (updateComplexDto.personInChargeId) {
      const isValid = await this.validatePersonInCharge(
        updateComplexDto.personInChargeId,
        complexId,
      );

      if (!isValid) {
        throw new BadRequestException({
          code: 'COMPLEX_002',
          message: ERROR_CODES.COMPLEX_002.message,
        });
      }
    }

    // Validate email format if provided (Requirement 4.6)
    if (updateComplexDto.email) {
      if (!ValidationUtil.validateEmail(updateComplexDto.email)) {
        throw new BadRequestException({
          code: 'COMPLEX_009',
          message: ERROR_CODES.COMPLEX_009.message,
        });
      }
    }

    // Validate phone format if provided (Requirement 4.7)
    if (updateComplexDto.phone) {
      const normalizedUpdateLegacyPhone = this.normalizePhoneValue(
        updateComplexDto.phone,
      );
      if (
        normalizedUpdateLegacyPhone &&
        !ValidationUtil.validatePhone(normalizedUpdateLegacyPhone)
      ) {
        throw new BadRequestException({
          code: 'COMPLEX_010',
          message: ERROR_CODES.COMPLEX_010.message,
        });
      }
    }

    const normalizedUpdatePhoneNumbers = this.normalizePhoneNumbers(
      (updateComplexDto as any).phone,
      (updateComplexDto as any).phoneNumbers,
    );
    if (
      normalizedUpdatePhoneNumbers.some(
        (entry) => !ValidationUtil.validatePhone(entry.number),
      )
    ) {
      throw new BadRequestException({
        code: 'COMPLEX_010',
        message: ERROR_CODES.COMPLEX_010.message,
      });
    }

    // Validate business profile data if provided
    if (this.hasBusinessProfileData(updateComplexDto)) {
      const businessProfileValidation = ValidationUtil.validateBusinessProfile({
        yearEstablished: updateComplexDto.yearEstablished,
        mission: updateComplexDto.mission,
        vision: updateComplexDto.vision,
        ceoName: updateComplexDto.ceoName,
        vatNumber: updateComplexDto.vatNumber,
        crNumber: updateComplexDto.crNumber,
      });

      if (!businessProfileValidation.isValid) {
        throw new BadRequestException({
          message: {
            ar: `فشل التحقق: ${businessProfileValidation.errors.join(', ')}`,
            en: `Validation failed: ${businessProfileValidation.errors.join(', ')}`,
          },
        });
      }
    }

    // Update complex fields (excluding departmentIds as it's not a direct field)
    const {
      departmentIds,
      phone: updatePhone,
      phoneNumbers: updatePhoneNumbers,
      googleLocation: updateGoogleLocation,
      ...updateData
    } = updateComplexDto as any;

    if (updatePhone !== undefined || updatePhoneNumbers !== undefined) {
      (updateData as any).phoneNumbers = normalizedUpdatePhoneNumbers;
    }

    if (updateGoogleLocation) {
      (updateData as any).address = {
        ...(complex.address || {}),
        googleLocation: updateGoogleLocation,
      };
    }

    // Convert personInChargeId to ObjectId if provided
    if (updateData.personInChargeId) {
      (updateData as any).personInChargeId = new Types.ObjectId(
        updateData.personInChargeId,
      );
    }

    Object.assign(complex, updateData);
    await complex.save();

    // Sync complex_departments if departmentIds were provided
    if (departmentIds != null) {
      const newDepartmentIds = (departmentIds ?? []) as string[];

      // Add departments that are in new list but not currently linked
      const depsToAdd = newDepartmentIds.filter(
        (id) => !currentDepartmentIds.includes(id),
      );
      if (depsToAdd.length > 0) {
        await this.complexModel.db.collection('complex_departments').insertMany(
          depsToAdd.map((departmentId) => ({
            complexId: new Types.ObjectId(complexId),
            departmentId: new Types.ObjectId(departmentId),
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }

      // Remove departments that were dropped from the list
      const depsToRemove = currentDepartmentIds.filter(
        (id) => !newDepartmentIds.includes(id),
      );
      if (depsToRemove.length > 0) {
        await this.complexModel.db.collection('complex_departments').deleteMany({
          complexId: new Types.ObjectId(complexId),
          departmentId: {
            $in: depsToRemove.map((id) => new Types.ObjectId(id)),
          },
        });
      }
    }

    // Populate relationships in response (Requirement 4.8)
    const populatedComplex = await this.complexModel
      .findById(complexId)
      .populate('organizationId', 'name email phone address')
      .populate('subscriptionId', 'planId startDate endDate status')
      .populate('ownerId', 'firstName lastName email role')
      .populate('personInChargeId', 'firstName lastName email role')
      .exec();

    // Fetch linked departments for response
    const departments = await this.complexModel.db
      .collection('complex_departments')
      .aggregate([
        {
          $match: {
            complexId: new Types.ObjectId(complexId),
            isActive: true,
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: 'departmentId',
            foreignField: '_id',
            as: 'department',
          },
        },
        { $unwind: '$department' },
        { $replaceRoot: { newRoot: '$department' } },
      ])
      .toArray();

    // Return updated complex with departmentRestrictions if any
    return {
      success: true,
      data: {
        ...(populatedComplex as any).toObject(),
        departments,
      },
      departmentRestrictions,
      message: {
        ar: 'تم تحديث المجمع بنجاح',
        en: 'Complex updated successfully',
      },
    };
  }

  async setupBusinessProfile(
    complexId: string,
    businessProfileDto: SetupBusinessProfileDto,
  ): Promise<Complex> {
    const complex = await this.getComplex(complexId);

    // Validate business profile
    const validation =
      ValidationUtil.validateBusinessProfile(businessProfileDto);
    if (!validation.isValid) {
      throw new BadRequestException({
        message: {
          ar: `فشل التحقق: ${validation.errors.join(', ')}`,
          en: `Validation failed: ${validation.errors.join(', ')}`,
        },
      });
    }

    Object.assign(complex, businessProfileDto);
    return await complex.save();
  }

  private hasBusinessProfileData(data: any): boolean {
    return !!(
      data.yearEstablished ||
      data.mission ||
      data.vision ||
      data.ceoName ||
      data.vatNumber ||
      data.crNumber
    );
  }

  // ======== VALIDATION METHODS ========

  async isNameAvailable(
    name: string,
    organizationId?: string,
  ): Promise<boolean> {
    try {
      const trimmedName = name.trim().toLowerCase();
      if (!trimmedName) return false;

      const query: any = {
        name: { $regex: new RegExp(`^${trimmedName}$`, 'i') },
      };

      // If organizationId is provided, check within that organization scope
      if (organizationId) {
        query.organizationId = new Types.ObjectId(organizationId);
      }

      const existingComplex = await this.complexModel.findOne(query).exec();
      return !existingComplex;
    } catch (error) {
      console.error('Error checking complex name availability:', error);
      return false;
    }
  }

  async isEmailAvailable(email: string): Promise<boolean> {
    try {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail) return false;

      const existingComplex = await this.complexModel
        .findOne({
          email: { $regex: new RegExp(`^${trimmedEmail}$`, 'i') },
        })
        .exec();

      return !existingComplex;
    } catch (error) {
      console.error('Error checking email availability:', error);
      return false;
    }
  }

  // ======== HELPER METHODS FOR CALCULATIONS ========

  /**
   * Calculate the number of scheduled appointments for a complex
   * Counts appointments with status 'scheduled' or 'confirmed' that are not deleted
   *
   * @param complexId - The complex ID
   * @returns Promise<number> - Count of scheduled appointments
   *
   * Requirements: 1.2, 2.3
   */
  private async calculateScheduledAppointments(
    complexId: string,
  ): Promise<number> {
    // First, get all active clinics for this complex
    const clinics = await this.complexModel
      .aggregate([
        {
          $match: {
            _id: new Types.ObjectId(complexId),
          },
        },
        {
          $lookup: {
            from: 'clinics',
            localField: '_id',
            foreignField: 'complexId',
            as: 'clinics',
          },
        },
        {
          $unwind: {
            path: '$clinics',
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            'clinics.isActive': true,
            'clinics.deletedAt': null,
          },
        },
        {
          $group: {
            _id: null,
            clinicIds: { $push: '$clinics._id' },
          },
        },
      ])
      .exec();

    if (!clinics || clinics.length === 0 || !clinics[0].clinicIds) {
      return 0;
    }

    const clinicIds = clinics[0].clinicIds;

    // Count appointments with status 'scheduled' or 'confirmed' for these clinics
    const count = await this.complexModel.db
      .collection('appointments')
      .countDocuments({
        clinicId: { $in: clinicIds },
        status: { $in: ['scheduled', 'confirmed'] },
        deletedAt: null,
      });

    return count;
  }

  /**
   * Calculate the number of active clinics assigned to a complex
   * Counts clinics that are active and not deleted
   *
   * @param complexId - The complex ID
   * @returns Promise<number> - Count of active clinics
   *
   * Requirements: 1.3, 2.4
   */
  private async calculateClinicsAssigned(complexId: string): Promise<number> {
    const count = await this.complexModel.db
      .collection('clinics')
      .countDocuments({
        complexId: new Types.ObjectId(complexId),
        isActive: true,
        deletedAt: null,
      });

    return count;
  }

  private async getAssignedClinicList(
    complexId: string,
  ): Promise<AssignedClinicSummary[]> {
    const clinics = await this.complexModel.db
      .collection('clinics')
      .find({
        complexId: new Types.ObjectId(complexId),
        deletedAt: null,
      })
      .sort({ name: 1 })
      .toArray();

    if (clinics.length === 0) {
      return [];
    }

    const clinicIds = clinics.map((clinic) => clinic._id);
    const picUserIds = [
      ...new Set(
        clinics
          .map((clinic) => clinic.personInChargeId?.toString())
          .filter((id): id is string => !!id),
      ),
    ];

    const [appointmentsByClinic, doctorsByClinic, picUsers] =
      await Promise.all([
        this.complexModel.db
          .collection('appointments')
          .aggregate([
            {
              $match: {
                clinicId: { $in: clinicIds },
                status: { $in: ['scheduled', 'confirmed'] },
                deletedAt: { $exists: false },
              },
            },
            {
              $group: {
                _id: '$clinicId',
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        this.complexModel.db
          .collection('users')
          .aggregate([
            {
              $match: {
                clinicId: { $in: clinicIds },
                role: 'doctor',
                isActive: true,
              },
            },
            {
              $group: {
                _id: '$clinicId',
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        picUserIds.length
          ? this.complexModel.db
              .collection('users')
              .find({
                _id: {
                  $in: picUserIds.map((id) => new Types.ObjectId(id)),
                },
              })
              .project({
                firstName: 1,
                lastName: 1,
              })
              .toArray()
          : [],
      ]);

    const appointmentCountMap = new Map(
      appointmentsByClinic.map((item) => [item._id.toString(), item.count]),
    );
    const doctorsCountMap = new Map(
      doctorsByClinic.map((item) => [item._id.toString(), item.count]),
    );
    const picNameMap = new Map<string, string>(
      picUsers.map(
        (user): [string, string] => [
          user._id.toString(),
          `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        ],
      ),
    );

    return clinics.map((clinic, index) => {
      const picName =
      (clinic.personInChargeId &&
        picNameMap.get(clinic.personInChargeId.toString())) ||
      clinic.headDoctorName ||
      clinic.ceoName ||
      null;

      return {
        no: index + 1,
        clinicId: clinic._id.toString(),
        name: clinic.name,
        PIC: picName,
        pic: picName,
        personInCharge: picName ? { name: picName } : null,
        scheduledAppointmentsCount:
          appointmentCountMap.get(clinic._id.toString()) || 0,
        doctors: doctorsCountMap.get(clinic._id.toString()) || 0,
        status:
          clinic.status || (clinic.isActive === false ? 'inactive' : 'active'),
      };
    });
  }

  private async getDoctorAndStaffList(
    complexId: string,
  ): Promise<DoctorStaffSummary[]> {
    const users = await this.complexModel.db
      .collection('users')
      .find({
        complexId: new Types.ObjectId(complexId),
        role: { $in: ['doctor', 'staff'] },
      })
      .project({
        firstName: 1,
        lastName: 1,
        role: 1,
        isActive: 1,
        clinicId: 1,
         profilePictureUrl: 1,
      })
      .sort({ firstName: 1, lastName: 1 })
      .toArray();

    if (users.length === 0) {
      return [];
    }

    const uniqueClinicIds = [
      ...new Set(
        users
          .map((user) => user.clinicId?.toString())
          .filter((clinicId): clinicId is string => !!clinicId),
      ),
    ];

    const [clinics, employeeProfiles] = await Promise.all([
      uniqueClinicIds.length
        ? this.complexModel.db
            .collection('clinics')
            .find({
              _id: {
                $in: uniqueClinicIds.map((clinicId) => new Types.ObjectId(clinicId)),
              },
            })
            .project({ name: 1 })
            .toArray()
        : Promise.resolve([]),
      this.complexModel.db
        .collection('employee_profiles')
        .find({
          userId: { $in: users.map((u) => u._id) },
        })
        .project({ userId: 1, employeeNumber: 1 })
        .toArray(),
    ]);

    const clinicNameMap = new Map(
      clinics.map((clinic) => [clinic._id.toString(), clinic.name]),
    );
    const employeeNumberMap = new Map(
      employeeProfiles.map((ep) => [ep.userId.toString(), ep.employeeNumber]),
    );

    return users.map((user, index) => {
      const clinicId = user.clinicId?.toString() || null;
      return {
        no: index + 1,
        employeeNumber: employeeNumberMap.get(user._id.toString()) || null,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        clinic: clinicId ? clinicNameMap.get(clinicId) || null : null,
        userType: user.role,
        status: user.isActive ? 'active' : 'inactive',
        profilePictureUrl: user.profilePictureUrl || null, 
      };
    });
  }

  /**
   * Calculate capacity breakdown for a complex
   * Aggregates capacity from all active clinics and calculates utilization
   *
   * @param complexId - The complex ID
   * @returns Promise<CapacityBreakdown> - Complete capacity breakdown
   *
   * Requirements: 1.4, 2.6, 2.7, 7.1, 7.2, 7.3, 7.4, 7.5
   */
  private async calculateCapacity(
    complexId: string,
  ): Promise<CapacityBreakdown> {
    // Get all active clinics for this complex with their capacity settings
    const clinics = await this.complexModel.db
      .collection('clinics')
      .find({
        complexId: new Types.ObjectId(complexId),
        isActive: true,
        deletedAt: null,
      })
      .toArray();

    // Initialize totals
    let totalMaxDoctors = 0;
    let totalMaxStaff = 0;
    let totalMaxPatients = 0;

    // Calculate total capacity from all clinics
    for (const clinic of clinics) {
      totalMaxDoctors += clinic.maxDoctors || 0;
      totalMaxStaff += clinic.maxStaff || 0;
      totalMaxPatients += clinic.maxPatients || 0;
    }

    // Get clinic IDs for current count queries
    const clinicIds = clinics.map((c) => c._id);

    // Calculate current counts
    let currentDoctors = 0;
    let currentStaff = 0;
    let currentPatients = 0;

    if (clinicIds.length > 0) {
      // Count doctors (users with role 'doctor' assigned to these clinics)
      currentDoctors = await this.complexModel.db
        .collection('users')
        .countDocuments({
          clinicId: { $in: clinicIds },
          role: 'doctor',
          isActive: true,
        });

      // Count staff (users with roles other than 'doctor' and 'patient' assigned to these clinics)
      currentStaff = await this.complexModel.db
        .collection('users')
        .countDocuments({
          clinicId: { $in: clinicIds },
          role: { $nin: ['doctor', 'patient'] },
          isActive: true,
        });

      // Count patients - we need to count unique patients with appointments at these clinics
      const patientAggregation = await this.complexModel.db
        .collection('appointments')
        .aggregate([
          {
            $match: {
              clinicId: { $in: clinicIds },
              deletedAt: null,
            },
          },
          {
            $group: {
              _id: '$patientId',
            },
          },
          {
            $count: 'total',
          },
        ])
        .toArray();

      currentPatients =
        patientAggregation.length > 0 ? patientAggregation[0].total : 0;
    }

    // Calculate utilization percentages
    const doctorUtilization =
      totalMaxDoctors > 0
        ? Math.round((currentDoctors / totalMaxDoctors) * 100)
        : 0;
    const staffUtilization =
      totalMaxStaff > 0 ? Math.round((currentStaff / totalMaxStaff) * 100) : 0;
    const patientUtilization =
      totalMaxPatients > 0
        ? Math.round((currentPatients / totalMaxPatients) * 100)
        : 0;

    // Build per-clinic breakdown
    const byClinic = await Promise.all(
      clinics.map(async (clinic) => {
        // Count doctors for this clinic
        const clinicDoctors = await this.complexModel.db
          .collection('users')
          .countDocuments({
            clinicId: clinic._id,
            role: 'doctor',
            isActive: true,
          });

        // Count staff for this clinic
        const clinicStaff = await this.complexModel.db
          .collection('users')
          .countDocuments({
            clinicId: clinic._id,
            role: { $nin: ['doctor', 'patient'] },
            isActive: true,
          });

        // Count patients for this clinic
        const clinicPatientAggregation = await this.complexModel.db
          .collection('appointments')
          .aggregate([
            {
              $match: {
                clinicId: clinic._id,
                deletedAt: null,
              },
            },
            {
              $group: {
                _id: '$patientId',
              },
            },
            {
              $count: 'total',
            },
          ])
          .toArray();

        const clinicPatients =
          clinicPatientAggregation.length > 0
            ? clinicPatientAggregation[0].total
            : 0;

        return {
          clinicId: clinic._id.toString(),
          clinicName: clinic.name,
          maxDoctors: clinic.maxDoctors || 0,
          maxStaff: clinic.maxStaff || 0,
          maxPatients: clinic.maxPatients || 0,
          currentDoctors: clinicDoctors,
          currentStaff: clinicStaff,
          currentPatients: clinicPatients,
        };
      }),
    );

    // Generate recommendations if capacity is exceeded
    const recommendations: string[] = [];
    if (doctorUtilization > 100) {
      recommendations.push(
        'Doctor capacity exceeded. Consider increasing maxDoctors or redistributing workload.',
      );
    }
    if (staffUtilization > 100) {
      recommendations.push(
        'Staff capacity exceeded. Consider hiring more staff or increasing maxStaff limit.',
      );
    }
    if (patientUtilization > 100) {
      recommendations.push(
        'Patient capacity exceeded. Consider expanding facilities or limiting patient intake.',
      );
    }

    return {
      total: {
        maxDoctors: totalMaxDoctors,
        maxStaff: totalMaxStaff,
        maxPatients: totalMaxPatients,
      },
      current: {
        doctors: currentDoctors,
        staff: currentStaff,
        patients: currentPatients,
      },
      utilization: {
        doctors: doctorUtilization,
        staff: staffUtilization,
        patients: patientUtilization,
      },
      byClinic,
      recommendations: recommendations.length > 0 ? recommendations : undefined,
    };
  }

  /**
   * Validate that a user is eligible to be person-in-charge of a complex
   * Checks: user exists, role is not 'patient', and user's complexId matches
   *
   * @param userId - The user ID to validate
   * @param complexId - The complex ID
   * @returns Promise<boolean> - True if valid, false otherwise
   *
   * Requirements: 3.3, 4.5, 8.2, 8.3
   */
  private async validatePersonInCharge(
    userId: string,
    complexId: string,
  ): Promise<boolean> {
    try {
      // Check if user exists
      const user = await this.complexModel.db.collection('users').findOne({
        _id: new Types.ObjectId(userId),
      });

      if (!user) {
        return false;
      }

      // Check user role is not 'patient'
      if (user.role === 'patient') {
        return false;
      }

      // Check user's complexId matches the complex
      if (
        !user.complexId ||
        user.complexId.toString() !== complexId.toString()
      ) {
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error validating person in charge:', error);
      return false;
    }
  }

  /**
   * Check if departments are linked to active clinics
   * Returns restrictions for departments that cannot be removed
   *
   * @param complexId - The complex ID
   * @param departmentIds - Array of department IDs to check
   * @returns Promise<DepartmentRestriction[]> - Array of restrictions
   *
   * Requirements: 4.2, 4.3
   */
  private async checkDepartmentRestrictions(
    complexId: string,
    departmentIds: string[],
  ): Promise<DepartmentRestriction[]> {
    const restrictions: DepartmentRestriction[] = [];

    // Get all complex_departments for this complex and the specified departments
    const complexDepartments = await this.complexModel.db
      .collection('complex_departments')
      .find({
        complexId: new Types.ObjectId(complexId),
        departmentId: {
          $in: departmentIds.map((id) => new Types.ObjectId(id)),
        },
        isActive: true,
      })
      .toArray();

    // For each complex_department, check if there are clinics linked to it
    for (const complexDept of complexDepartments) {
      const linkedClinics = await this.complexModel.db
        .collection('clinics')
        .find({
          complexDepartmentId: complexDept._id,
          deletedAt: null,
        })
        .toArray();

      if (linkedClinics.length > 0) {
        // Get department details
        const department = await this.complexModel.db
          .collection('departments')
          .findOne({
            _id: complexDept.departmentId,
          });

        restrictions.push({
          departmentId: complexDept.departmentId.toString(),
          departmentName: department?.name || 'Unknown Department',
          linkedClinics: linkedClinics.map((clinic) => ({
            clinicId: clinic._id.toString(),
            clinicName: clinic.name,
          })),
        });
      }
    }

    return restrictions;
  }

  /**
   * Soft delete a complex
   * Sets deletedAt timestamp without physically removing the record
   * Prevents deletion if complex has active clinics
   *
   * @param complexId - The complex ID to soft delete
   * @param requestingUser - The user making the request
   * @returns Promise<SuccessResponse> - Success response with bilingual message
   *
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
   */
  async softDeleteComplex(complexId: string, requestingUser?: any): Promise<any> {
    // Validate complex exists (Requirement 5.1)
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await this.verifyComplexOwnership(complex, requestingUser);

    // Check for active clinics (Requirement 5.2)
    const activeClinicsCount = await this.calculateClinicsAssigned(complexId);

    // If active clinics exist, throw COMPLEX_003 (Requirement 5.2)
    if (activeClinicsCount > 0) {
      throw new BadRequestException({
        code: 'COMPLEX_003',
        message: ERROR_CODES.COMPLEX_003.message,
      });
    }

    // Set deletedAt timestamp (Requirement 5.3, 5.4)
    complex.deletedAt = new Date();
    await complex.save();

    // Return bilingual success message (Requirement 5.5)
    return {
      success: true,
      message: {
        ar: 'تم حذف المجمع بنجاح',
        en: 'Complex deleted successfully',
      },
    };
  }

  /**
   * Update complex status with cascading effects
   * Handles deactivation with clinic transfers and appointment rescheduling
   * Uses MongoDB transactions for atomicity
   *
   * @param complexId - The complex ID
   * @param dto - Status update data
   * @param userId - User ID performing the status change (for audit trail)
   * @returns Promise<StatusChangeResponse> - Status change result with counts
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9
   */
  async updateComplexStatus(
    complexId: string,
    dto: UpdateComplexStatusDto,
    userId?: string,
    requestingUser?: any,
  ): Promise<StatusChangeResponse> {
    if (requestingUser?.planType === 'complex') {
      throw new ForbiddenException({
        message: {
          ar: 'لا يمكن تغيير حالة المجمع في خطة المجمع',
          en: 'Status change is not allowed for Complex Plan subscriptions',
        },
        code: 'COMPLEX_PLAN_RESTRICTION',
      });
    }

    // Start MongoDB transaction if supported (Requirement 6.8)
    const { session, useTransaction } = await TransactionUtil.startTransaction(
      this.connection,
    );
    const sessionOpts = TransactionUtil.getSessionOptions(
      session,
      useTransaction,
    );

    try {
      // Validate complex exists (Requirement 6.1)
      const complexQuery = this.complexModel.findById(complexId);
      if (session) complexQuery.session(session);
      const complex = await complexQuery.exec();

      if (!complex) {
        throw new NotFoundException({
          code: 'COMPLEX_006',
          message: ERROR_CODES.COMPLEX_006.message,
        });
      }

      // TENANT ISOLATION (ISSUE-009)
      await this.verifyComplexOwnership(complex, requestingUser);

      let servicesDeactivated = 0;
      let clinicsTransferred = 0;
      let appointmentsMarkedForRescheduling = 0;

      // If deactivating (inactive or suspended), handle cascading effects
      if (dto.status === 'inactive' || dto.status === 'suspended') {
        // Get all clinics for this complex
        const clinics = await this.complexModel.db
          .collection('clinics')
          .find(
            {
              complexId: new Types.ObjectId(complexId),
              isActive: true,
              deletedAt: null,
            },
            sessionOpts,
          )
          .toArray();

        const clinicIds = clinics.map((c) => c._id);

        // If complex has clinics, validate targetComplexId is provided (Requirement 6.1, COMPLEX_004)
        if (clinics.length > 0 && !dto.targetComplexId) {
          throw new BadRequestException({
            code: 'COMPLEX_004',
            message: ERROR_CODES.COMPLEX_004.message,
            details: {
              en: 'This complex has active clinics. Choose a target complex and enable clinic transfer before deactivation.',
              ar: 'هذا المجمع يحتوي على عيادات نشطة. اختر مجمعا مستهدفا وفعل نقل العيادات قبل إلغاء التفعيل.',
            },
          });
        }

        if (clinics.length > 0 && dto.targetComplexId && !dto.transferClinics) {
          throw new BadRequestException({
            code: 'COMPLEX_004',
            message: {
              ar: 'يجب نقل جميع العيادات المرتبطة قبل إلغاء تفعيل المجمع',
              en: 'All linked clinics must be transferred before deactivating this complex',
            },
            details: {
              clinicsCount: clinics.length,
              en: 'Set transferClinics=true and provide targetComplexId.',
              ar: 'اجعل transferClinics=true وحدد targetComplexId.',
            },
          });
        }

        // Deactivate all services linked to the complex (Requirement 6.2)
        servicesDeactivated = await this.deactivateComplexServices(
          complexId,
          session,
        );

        // If targetComplexId is provided, validate and transfer clinics
        if (dto.targetComplexId) {
          // Validate target complex exists and is active (Requirement 6.1, COMPLEX_005)
          const targetQuery = this.complexModel.findById(dto.targetComplexId);
          if (session) targetQuery.session(session);
          const targetComplex = await targetQuery.exec();

          if (!targetComplex || targetComplex.status !== 'active') {
            throw new BadRequestException({
              code: 'COMPLEX_005',
              message: ERROR_CODES.COMPLEX_005.message,
            });
          }

          await this.verifyComplexOwnership(targetComplex, requestingUser);

          // Transfer clinics if requested (Requirement 6.3, 6.4)
          if (dto.transferClinics && clinicIds.length > 0) {
            clinicsTransferred = await this.transferClinicsToComplex(
              clinicIds,
              dto.targetComplexId,
              session,
            );

            await this.updateStaffAssignments(
              clinicIds,
              dto.targetComplexId,
              session,
            );

            // Mark appointments for rescheduling (Requirement 6.5)
            const markedBy = userId
              ? new Types.ObjectId(userId)
              : complex.ownerId;
            appointmentsMarkedForRescheduling =
              await this.markAppointmentsForRescheduling(
                clinicIds,
                dto.deactivationReason ||
                'Complex deactivated - clinics transferred',
                markedBy,
                session,
              );
          }
        }

        // Update complex status and deactivation fields (Requirement 6.6)
        complex.status = dto.status;
        complex.deactivatedAt = new Date();
        complex.deactivatedBy = userId
          ? new Types.ObjectId(userId)
          : complex.ownerId;
        complex.deactivationReason = dto.deactivationReason;
      } else {
        // Activating the complex
        complex.status = dto.status;
        // Clear deactivation fields when reactivating
        complex.deactivatedAt = undefined;
        complex.deactivatedBy = undefined;
        complex.deactivationReason = undefined;
      }

      await complex.save(sessionOpts);

      // Commit transaction (Requirement 6.8)
      await TransactionUtil.commitTransaction(session, useTransaction);

      // TODO: Send notifications to affected users (Requirement 6.8)
      // This will be implemented when notification service is available
      // await this.notificationService.notifyStatusChange(complexId, dto.status);

      // Populate relationships for response
      const populatedComplex = await this.complexModel
        .findById(complexId)
        .populate('organizationId', 'name email phone address')
        .populate('subscriptionId', 'planId startDate endDate status')
        .populate('ownerId', 'firstName lastName email role')
        .populate('personInChargeId', 'firstName lastName email role')
        .exec();

      // Return StatusChangeResponse with counts (Requirement 6.9)
      return {
        success: true,
        data: {
          complex: populatedComplex!,
          servicesDeactivated,
          clinicsTransferred:
            clinicsTransferred > 0 ? clinicsTransferred : undefined,
          appointmentsMarkedForRescheduling:
            appointmentsMarkedForRescheduling > 0
              ? appointmentsMarkedForRescheduling
              : undefined,
        },
        message: {
          ar: 'تم تحديث حالة المجمع بنجاح',
          en: 'Complex status updated successfully',
        },
      };
    } catch (error) {
      // Rollback transaction on error (Requirement 6.8)
      await TransactionUtil.abortTransaction(session, useTransaction);
      throw error;
    } finally {
      await TransactionUtil.endSession(session);
    }
  }

  // ======== STATUS MANAGEMENT HELPER METHODS ========

  /**
   * Deactivate all services linked to a complex
    * Updates isActive to false for all services linked via complexId or clinicId
   *
   * @param complexId - The complex ID
   * @param session - MongoDB session for transaction support
   * @returns Promise<number> - Count of services deactivated
   *
   * Requirements: 6.2
   */
  private async deactivateComplexServices(
    complexId: string,
    session: any,
  ): Promise<number> {
    const sessionOpts = session ? { session } : {};
    // Get all clinics for this complex
    const clinics = await this.complexModel.db
      .collection('clinics')
      .find(
        {
          complexId: new Types.ObjectId(complexId),
        },
        sessionOpts,
      )
      .toArray();

    const clinicIds = clinics.map((c) => c._id);

    // Update all services linked to this complex or its clinics
    const result = await this.complexModel.db.collection('services').updateMany(
      {
        $or: [
          { clinicId: { $in: clinicIds } },
          { complexId: new Types.ObjectId(complexId) },
        ],
      },
      {
        $set: { isActive: false },
      },
      sessionOpts,
    );

    return result.modifiedCount;
  }

  /**
   * Transfer clinics to a target complex
   * Updates all clinic records with new complexId
   *
   * @param clinicIds - Array of clinic IDs to transfer
   * @param targetComplexId - The target complex ID
   * @param session - MongoDB session for transaction support
   * @returns Promise<number> - Count of clinics transferred
   *
   * Requirements: 6.3, 6.4
   */
  private async transferClinicsToComplex(
    clinicIds: Types.ObjectId[],
    targetComplexId: string,
    session: any,
  ): Promise<number> {
    const sessionOpts = session ? { session } : {};
    // Update all clinic records with new complexId
    const result = await this.complexModel.db.collection('clinics').updateMany(
      {
        _id: { $in: clinicIds },
      },
      {
        $set: { complexId: new Types.ObjectId(targetComplexId) },
      },
      sessionOpts,
    );

    return result.modifiedCount;
  }

  /**
   * Mark appointments for rescheduling
   * Sets reschedulingReason, markedForReschedulingAt, and markedBy fields
   *
   * @param clinicIds - Array of clinic IDs whose appointments need rescheduling
   * @param reason - Reason for rescheduling
   * @param markedBy - User ID who marked for rescheduling
   * @param session - MongoDB session for transaction support
   * @returns Promise<number> - Count of appointments marked
   *
   * Requirements: 6.5
   */
  private async markAppointmentsForRescheduling(
    clinicIds: Types.ObjectId[],
    reason: string,
    markedBy: Types.ObjectId,
    session: any,
  ): Promise<number> {
    const sessionOpts = session ? { session } : {};
    // Query appointments for specified clinics that are scheduled or confirmed
    const result = await this.complexModel.db
      .collection('appointments')
      .updateMany(
        {
          clinicId: { $in: clinicIds },
          status: { $in: ['scheduled', 'confirmed'] },
          deletedAt: null,
        },
        {
          $set: {
            reschedulingReason: reason,
            markedForReschedulingAt: new Date(),
            markedBy: markedBy,
          },
        },
        sessionOpts,
      );

    return result.modifiedCount;
  }

  // ======== CAPACITY CALCULATION ENDPOINT ========

  /**
   * Get complex capacity with breakdown and utilization
   * Public endpoint for capacity calculation
   *
   * @param complexId - The complex ID
   * @param requestingUser - The user making the request
   * @returns Promise<CapacityResponse> - Capacity breakdown with bilingual message
   *
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   */
  async getComplexCapacity(complexId: string, requestingUser?: any): Promise<any> {
    // Validate complex exists (throw COMPLEX_006 if not)
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await this.verifyComplexOwnership(complex, requestingUser);

    // Call calculateCapacity() helper
    const capacity = await this.calculateCapacity(complexId);

    // Return CapacityResponse with breakdown
    return {
      success: true,
      data: capacity,
      message: {
        ar: 'تم حساب سعة المجمع بنجاح',
        en: 'Complex capacity calculated successfully',
      },
    };
  }

  // ======== PIC MANAGEMENT ENDPOINTS ========

  /**
   * Assign a person-in-charge to a complex
   * Validates user exists, is an employee of the complex, and has appropriate role
   *
   * @param complexId - The complex ID
   * @param userId - The user ID to assign as PIC
   * @param requestingUser - The user making the request
   * @returns Promise<Complex> - Complex with populated personInCharge
   *
   * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
   */
  async assignPersonInCharge(
    complexId: string,
    userId: string,
    requestingUser?: any,
  ): Promise<any> {
    // Validate complex exists (throw COMPLEX_006 if not) - Requirement 8.1
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await this.verifyComplexOwnership(complex, requestingUser);

    // Validate user exists (throw COMPLEX_002 if not) - Requirement 8.1
    const user = await this.complexModel.db.collection('users').findOne({
      _id: new Types.ObjectId(userId),
    });

    if (!user) {
      throw new BadRequestException({
        code: 'COMPLEX_002',
        message: ERROR_CODES.COMPLEX_002.message,
      });
    }

    // Call validatePersonInCharge() (throw COMPLEX_002 if invalid) - Requirements 8.2, 8.3
    const isValid = await this.validatePersonInCharge(userId, complexId);
    if (!isValid) {
      throw new BadRequestException({
        code: 'COMPLEX_002',
        message: ERROR_CODES.COMPLEX_002.message,
      });
    }

    // Update personInChargeId field - Requirement 8.4
    complex.personInChargeId = new Types.ObjectId(userId);
    await complex.save();

    // Populate personInCharge in response - Requirement 8.5
    const populatedComplex = await this.complexModel
      .findById(complexId)
      .populate('organizationId', 'name email phone address')
      .populate('subscriptionId', 'planId startDate endDate status')
      .populate('ownerId', 'firstName lastName email role')
      .populate('personInChargeId', 'firstName lastName email role')
      .exec();

    // Return complex with bilingual success message - Requirement 8.5
    return {
      success: true,
      data: populatedComplex,
      message: {
        ar: 'تم تعيين الشخص المسؤول بنجاح',
        en: 'Person-in-charge assigned successfully',
      },
    };
  }

  /**
   * Remove person-in-charge from a complex
   * Sets personInChargeId to null
   *
   * @param complexId - The complex ID
   * @param requestingUser - The user making the request
   * @returns Promise<SuccessResponse> - Success response with bilingual message
   *
   * Requirements: 9.1, 9.2, 9.3
   */
  async removePersonInCharge(complexId: string, requestingUser?: any): Promise<any> {
    // Validate complex exists (throw COMPLEX_006 if not) - Requirement 9.1
    const complex = await this.complexModel.findById(complexId).exec();
    if (!complex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await this.verifyComplexOwnership(complex, requestingUser);

    // Set personInChargeId to null - Requirement 9.2
    complex.personInChargeId = undefined;
    await complex.save();

    // Return bilingual success message - Requirement 9.3
    return {
      success: true,
      message: {
        ar: 'تم إزالة الشخص المسؤول بنجاح',
        en: 'Person-in-charge removed successfully',
      },
    };
  }

  // ======== CLINIC TRANSFER HELPER METHODS ========

  /**
   * Check for working hours conflicts between source and target complexes
   * Compares schedules and identifies conflicts
   *
   * @param sourceComplexId - The source complex ID
   * @param targetComplexId - The target complex ID
   * @param clinicIds - Array of clinic IDs being transferred
   * @returns Promise<WorkingHoursConflict[]> - Array of conflicts with details
   *
   * Requirements: 10.6
   */
  private async checkWorkingHoursConflicts(
    sourceComplexId: string,
    targetComplexId: string,
    clinicIds: Types.ObjectId[],
  ): Promise<any[]> {
    const conflicts: any[] = [];

    try {
      // Get working hours for source complex
      const sourceWorkingHours = await this.complexModel.db
        .collection('working_hours')
        .find({
          scopeType: 'complex',
          scopeId: new Types.ObjectId(sourceComplexId),
          isActive: true,
        })
        .toArray();

      // Get working hours for target complex
      const targetWorkingHours = await this.complexModel.db
        .collection('working_hours')
        .find({
          scopeType: 'complex',
          scopeId: new Types.ObjectId(targetComplexId),
          isActive: true,
        })
        .toArray();

      // Get clinic details for better conflict reporting
      const clinics = await this.complexModel.db
        .collection('clinics')
        .find({
          _id: { $in: clinicIds },
        })
        .toArray();

      // Compare working hours and identify conflicts
      for (const clinic of clinics) {
        // Get clinic-specific working hours if any
        const clinicWorkingHours = await this.complexModel.db
          .collection('working_hours')
          .find({
            scopeType: 'clinic',
            scopeId: clinic._id,
            isActive: true,
          })
          .toArray();

        // Check if there are any working hours defined
        const hasSourceHours =
          sourceWorkingHours.length > 0 || clinicWorkingHours.length > 0;
        const hasTargetHours = targetWorkingHours.length > 0;

        if (hasSourceHours && hasTargetHours) {
          // Compare day availability
          const sourceDays = new Set(
            [...sourceWorkingHours, ...clinicWorkingHours].map(
              (wh) => wh.dayOfWeek,
            ),
          );
          const targetDays = new Set(
            targetWorkingHours.map((wh) => wh.dayOfWeek),
          );

          // Check for days that exist in source but not in target
          const missingDays = Array.from(sourceDays).filter(
            (day) => !targetDays.has(day),
          );

          if (missingDays.length > 0) {
            conflicts.push({
              clinicId: clinic._id.toString(),
              clinicName: clinic.name,
              conflictType: 'missing_days',
              details: `Target complex does not have working hours for days: ${missingDays.join(', ')}`,
            });
          }

          // Check for time conflicts (simplified - checks if target has shorter hours)
          for (const sourceWH of [
            ...sourceWorkingHours,
            ...clinicWorkingHours,
          ]) {
            const targetWH = targetWorkingHours.find(
              (twh) => twh.dayOfWeek === sourceWH.dayOfWeek,
            );

            if (targetWH) {
              // Compare start and end times
              const sourceStart = sourceWH.startTime;
              const sourceEnd = sourceWH.endTime;
              const targetStart = targetWH.startTime;
              const targetEnd = targetWH.endTime;

              // Check if target hours are more restrictive
              if (targetStart > sourceStart || targetEnd < sourceEnd) {
                conflicts.push({
                  clinicId: clinic._id.toString(),
                  clinicName: clinic.name,
                  conflictType: 'time_mismatch',
                  details: `Working hours mismatch on ${sourceWH.dayOfWeek}: Source (${sourceStart}-${sourceEnd}) vs Target (${targetStart}-${targetEnd})`,
                });
              }
            }
          }
        } else if (hasSourceHours && !hasTargetHours) {
          // Target complex has no working hours defined
          conflicts.push({
            clinicId: clinic._id.toString(),
            clinicName: clinic.name,
            conflictType: 'no_target_hours',
            details: 'Target complex has no working hours defined',
          });
        }
      }
    } catch (error) {
      console.error('Error checking working hours conflicts:', error);
      // Return empty array on error to not block the transfer
      // The transfer can proceed but without conflict detection
    }

    return conflicts;
  }

  private normalizePhoneNumbers(
    legacyPhone?: string,
    phoneNumbersInput?: any[],
  ): Array<{ number: string; type: 'primary'; label: string }> {
    const extracted =
      phoneNumbersInput !== undefined
        ? this.extractPhoneNumberStrings(phoneNumbersInput)
        : this.extractPhoneNumberStrings(legacyPhone ? [legacyPhone] : []);

    const unique = Array.from(new Set(extracted));
    return unique.map((number) => ({ number, type: 'primary', label: 'Main' }));
  }

  private extractPhoneNumberStrings(values?: any[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    return values
      .map((value) => {
        if (typeof value === 'string') return this.normalizePhoneValue(value);
        if (value && typeof value === 'object' && typeof value.number === 'string') {
          return this.normalizePhoneValue(value.number);
        }
        return '';
      })
      .filter(Boolean);
  }

  private normalizePhoneValue(value?: string): string {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('+')) return trimmed;

    const cleaned = trimmed.replace(/[\s-]/g, '');
    if (/^\d+$/.test(cleaned)) {
      return `+${cleaned}`;
    }

    return trimmed;
  }

  /**
   * Update staff assignments when clinics are transferred
   * Updates complexId for all users assigned to the transferred clinics
   *
   * @param clinicIds - Array of clinic IDs being transferred
   * @param targetComplexId - The target complex ID
   * @param session - MongoDB session for transaction support
   * @returns Promise<number> - Count of staff updated
   *
   * Requirements: 10.5
   */
  private async updateStaffAssignments(
    clinicIds: Types.ObjectId[],
    targetComplexId: string,
    session: any,
  ): Promise<number> {
    const sessionOpts = session ? { session } : {};
    // Query users with clinicId in transferred clinics
    // Update their complexId to target complex
    const result = await this.complexModel.db.collection('users').updateMany(
      {
        clinicId: { $in: clinicIds },
        isActive: true,
      },
      {
        $set: { complexId: new Types.ObjectId(targetComplexId) },
      },
      sessionOpts,
    );

    return result.modifiedCount;
  }

  /**
   * Transfer clinics from source complex to target complex
   * Handles all related data updates atomically using transactions
   *
   * @param sourceComplexId - The source complex ID
   * @param targetComplexId - The target complex ID
   * @param clinicIds - Array of clinic IDs to transfer
   * @param requestingUser - The user making the request
   * @returns Promise<TransferResponse> - Transfer result with counts and conflicts
   *
   * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.9
   */
  async transferClinics(
    sourceComplexId: string,
    targetComplexId: string,
    clinicIds: string[],
    requestingUser?: any,
  ): Promise<any> {
    // Validate both complexes exist
    const [sourceComplex, targetComplex] = await Promise.all([
      this.complexModel.findById(sourceComplexId).exec(),
      this.complexModel.findById(targetComplexId).exec(),
    ]);

    if (!sourceComplex || !targetComplex) {
      throw new NotFoundException({
        code: 'COMPLEX_006',
        message: ERROR_CODES.COMPLEX_006.message,
      });
    }

    // TENANT ISOLATION (ISSUE-009)
    await Promise.all([
      this.verifyComplexOwnership(sourceComplex, requestingUser),
      this.verifyComplexOwnership(targetComplex, requestingUser),
    ]);
    // Start MongoDB transaction if supported (Requirement 10.4, 13.1, 13.2)
    const { session, useTransaction } = await TransactionUtil.startTransaction(
      this.connection,
    );
    const sessionOpts = TransactionUtil.getSessionOptions(
      session,
      useTransaction,
    );

    try {
      // Validate source complex exists (throw COMPLEX_006 if not) - Requirement 10.1
      const sourceQuery = this.complexModel.findById(sourceComplexId);
      if (session) sourceQuery.session(session);
      const sourceComplex = await sourceQuery.exec();

      if (!sourceComplex) {
        throw new NotFoundException({
          code: 'COMPLEX_006',
          message: ERROR_CODES.COMPLEX_006.message,
        });
      }

      // Validate target complex exists and is active (throw COMPLEX_005 if not) - Requirement 10.2
      const targetQuery = this.complexModel.findById(targetComplexId);
      if (session) targetQuery.session(session);
      const targetComplex = await targetQuery.exec();

      if (!targetComplex || targetComplex.status !== 'active') {
        throw new BadRequestException({
          code: 'COMPLEX_005',
          message: ERROR_CODES.COMPLEX_005.message,
        });
      }

      // Convert clinic IDs to ObjectId
      const clinicObjectIds = clinicIds.map((id) => new Types.ObjectId(id));

      // Validate all clinic IDs exist and belong to source complex (Requirement 10.3)
      const clinics = await this.complexModel.db
        .collection('clinics')
        .find(
          {
            _id: { $in: clinicObjectIds },
          },
          sessionOpts,
        )
        .toArray();

      // Check if all clinics were found
      if (clinics.length !== clinicIds.length) {
        throw new BadRequestException({
          message: {
            ar: 'بعض العيادات غير موجودة',
            en: 'Some clinics not found',
          },
        });
      }

      // Check if all clinics belong to source complex
      const invalidClinics = clinics.filter(
        (clinic) => clinic.complexId.toString() !== sourceComplexId,
      );

      if (invalidClinics.length > 0) {
        throw new BadRequestException({
          message: {
            ar: 'بعض العيادات لا تنتمي إلى المجمع المصدر',
            en: 'Some clinics do not belong to the source complex',
          },
        });
      }

      // Call transferClinicsToComplex() with session (Requirement 10.4)
      const clinicsTransferred = await this.transferClinicsToComplex(
        clinicObjectIds,
        targetComplexId,
        session,
      );

      // Call updateStaffAssignments() with session (Requirement 10.5)
      const staffUpdated = await this.updateStaffAssignments(
        clinicObjectIds,
        targetComplexId,
        session,
      );

      // Call checkWorkingHoursConflicts() (Requirement 10.6)
      const conflicts = await this.checkWorkingHoursConflicts(
        sourceComplexId,
        targetComplexId,
        clinicObjectIds,
      );

      // If conflicts, call markAppointmentsForRescheduling() with session (Requirement 10.7)
      let appointmentsMarkedForRescheduling = 0;
      if (conflicts.length > 0) {
        const markedBy = sourceComplex.ownerId;
        appointmentsMarkedForRescheduling =
          await this.markAppointmentsForRescheduling(
            clinicObjectIds,
            'Working hours conflicts detected during clinic transfer',
            markedBy,
            session,
          );
      }

      // Commit transaction (Requirement 10.4, 13.1)
      await TransactionUtil.commitTransaction(session, useTransaction);

      // Return TransferResponse with counts and conflicts (Requirement 10.9)
      return {
        success: true,
        data: {
          clinicsTransferred,
          staffUpdated,
          appointmentsMarkedForRescheduling,
          conflicts,
        },
        message: {
          ar: 'تم نقل العيادات بنجاح',
          en: 'Clinics transferred successfully',
        },
      };
    } catch (error) {
      // Rollback transaction on error (Requirement 13.3)
      await TransactionUtil.abortTransaction(session, useTransaction);
      throw error;
    } finally {
      await TransactionUtil.endSession(session);
    }
  }

  /**
   * Verified that the requesting user has access to the complex
   */
  private async verifyComplexOwnership(complex: any, requestingUser: any) {
    if (!requestingUser || requestingUser.role === 'super_admin') {
      return;
    }

    if (requestingUser.subscriptionId && complex.subscriptionId?.toString() !== requestingUser.subscriptionId) {
      throw new ForbiddenException({
        message: {
          ar: 'ليس لديك صلاحية للوصول إلى هذا المجمع',
          en: 'You do not have permission to access this complex',
        },
        code: 'INSUFFICIENT_PERMISSIONS',
      });
    }
  }
}
