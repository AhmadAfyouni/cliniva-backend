import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Put,
  Query,
  Delete,
  Patch,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard, SkipAdminGuard } from '../auth/guards/admin.guard';
import { ComplexService } from './complex.service';
import { CreateComplexDto, UpdateComplexDto } from './dto/create-complex.dto';
import { ListComplexesQueryDto } from './dto/list-complexes-query.dto';
import { UpdateComplexStatusDto } from './dto/update-complex-status.dto';
import { AssignComplexPICDto } from './dto/assign-pic.dto';
import { TransferClinicsDto } from './dto/transfer-clinics.dto';

/**
 * Complex Management Controller
 *
 * Provides comprehensive endpoints for managing medical complexes including:
 * - Paginated listing with filters and calculated metrics
 * - Detailed complex retrieval with relationships
 * - CRUD operations with business rule validation
 * - Status management with cascading effects
 * - Capacity calculations and tracking
 * - Person-in-Charge (PIC) assignment
 * - Clinic transfers between complexes
 *
 * All endpoints support bilingual error messages (Arabic/English)
 * and follow consistent response structures.
 */
@ApiTags('Complex Management')
@Controller('complexes')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class ComplexController {
  constructor(private readonly complexService: ComplexService) { }

  /**
   * Get the complex assigned to the requesting user (Doctor/Staff)
   * Perm #21: View Assigned Complex — accessible by all authenticated roles
   * GET /complexes/assigned
   *
   * @SkipAdminGuard() bypasses the class-level AdminGuard for this endpoint,
   * allowing doctor and staff roles to access their assigned complex.
   */
  @Get('assigned')
  @SkipAdminGuard()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get assigned complex',
    description: 'Returns the complex assigned to the authenticated user. Accessible by all roles including Doctor and Staff (Perm #21).',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Assigned complex retrieved successfully' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No complex assigned to this user' })
  async getAssignedComplex(@Request() req: any) {
    return await this.complexService.getAssignedComplex(req.user);
  }

  /**
   * List complexes with pagination, filters, and optional counts
   * GET /complexes
   *
   * Requirements: 1.1, 1.11
   */
  @Get()
  @SkipAdminGuard()
  @ApiOperation({
    summary: 'List complexes with pagination and filters',
    description: `
      Retrieves a paginated list of medical complexes with optional filters and calculated metrics.
      
      **Features:**
      - Pagination support (page, limit)
      - Filtering by organization, subscription, status
      - Search by complex name (case-insensitive)
      - Sorting by any field
      - Optional counts (appointments, clinics, capacity)
      
      **Use Cases:**
      - Display complexes in admin dashboard
      - Filter complexes by organization or subscription
      - Monitor complex capacity and utilization
      - Search for specific complexes
      
      **Requirements:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11
    `,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1, min: 1)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 10, min: 1, max: 100)',
    example: 10,
  })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    type: String,
    description: 'Filter by organization ID',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiQuery({
    name: 'subscriptionId',
    required: false,
    type: String,
    description: 'Filter by subscription ID',
    example: '507f1f77bcf86cd799439012',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive', 'suspended'],
    description: 'Filter by status',
    example: 'active',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by complex name (case-insensitive)',
    example: 'Medical Center',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order',
    example: 'desc',
  })
  @ApiQuery({
    name: 'includeCounts',
    required: false,
    type: Boolean,
    description: 'Include calculated counts (appointments, clinics, capacity)',
    example: true,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complexes retrieved successfully',
    schema: {
      example: {
        success: true,
        data: [
          {
            _id: '507f1f77bcf86cd799439011',
            name: 'Central Medical Complex',
            status: 'active',
            email: 'info@centralmedical.com',
            phoneNumbers: ['+966501234567'],
            address: {
              street: 'King Fahd Road',
              city: 'Riyadh',
              country: 'Saudi Arabia',
            },
            personInCharge: {
              _id: '507f1f77bcf86cd799439013',
              firstName: 'Ahmed',
              lastName: 'Al-Saud',
              email: 'ahmed@centralmedical.com',
            },
            scheduledAppointmentsCount: 45,
            clinicsAssignedCount: 8,
            capacity: {
              total: { maxDoctors: 50, maxStaff: 100, maxPatients: 500 },
              current: { doctors: 35, staff: 75, patients: 320 },
              utilization: { doctors: 70, staff: 75, patients: 64 },
            },
            createdAt: '2024-01-15T10:00:00.000Z',
            updatedAt: '2024-01-20T15:30:00.000Z',
          },
        ],
        meta: {
          page: 1,
          limit: 10,
          total: 25,
          totalPages: 3,
        },
        message: {
          ar: 'تم استرجاع قائمة المجمعات بنجاح',
          en: 'Complexes list retrieved successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid query parameters',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'معاملات الاستعلام غير صالحة',
            en: 'Invalid query parameters',
          },
          details: 'Page must be a positive number',
        },
      },
    },
  })
  async listComplexes(@Query() query: ListComplexesQueryDto, @Request() req: any) {
    try {
      return await this.complexService.listComplexes(query, req.user);
    } catch (error) {
      // Handle specific error types
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'حدث خطأ أثناء استرجاع قائمة المجمعات',
              en: 'An error occurred while retrieving complexes list',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle unexpected errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء استرجاع قائمة المجمعات',
            en: 'An unexpected error occurred while retrieving complexes list',
          },
          details: error.message,
        },
      };
    }
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new medical complex',
    description: `
      Creates a new medical complex with validation for subscription limits and business rules.
      
      **Validations:**
      - Subscription must be active (COMPLEX_008)
      - Complex plan allows maximum 1 complex (COMPLEX_001)
      - Person-in-charge must be an employee (COMPLEX_002)
      - Email format validation (COMPLEX_009)
      - Phone format validation (COMPLEX_010)
      
      **Business Rules:**
      - BZR-28: Complex plan subscription limit enforcement
      - BZR-34: Person-in-charge validation
      
      **Requirements:** 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
    `,
  })
  @ApiBody({
    type: CreateComplexDto,
    description: 'Complex creation data',
    examples: {
      'Company Plan Complex': {
        value: {
          name: 'Central Medical Complex',
          organizationId: '507f1f77bcf86cd799439011',
          subscriptionId: '507f1f77bcf86cd799439012',
          ownerId: '507f1f77bcf86cd799439013',
          email: 'info@centralmedical.com',
          phoneNumbers: ['+966501234567', '+966502345678'],
          address: {
            street: 'King Fahd Road',
            city: 'Riyadh',
            state: 'Riyadh Province',
            postalCode: '12345',
            country: 'Saudi Arabia',
          },
          personInChargeId: '507f1f77bcf86cd799439014',
          departmentIds: [
            '507f1f77bcf86cd799439015',
            '507f1f77bcf86cd799439016',
          ],
        },
        summary: 'Create complex for company plan with organization',
      },
      'Complex Plan': {
        value: {
          name: 'Standalone Medical Complex',
          subscriptionId: '507f1f77bcf86cd799439012',
          ownerId: '507f1f77bcf86cd799439013',
          email: 'info@standalone.com',
          phoneNumbers: ['+966501234567'],
          address: {
            street: 'Al Olaya Street',
            city: 'Riyadh',
            country: 'Saudi Arabia',
          },
          businessProfile: {
            yearEstablished: 2020,
            mission: 'Provide quality healthcare',
            vision: 'Leading healthcare provider',
            overview: 'Multi-specialty medical complex',
          },
        },
        summary: 'Create complex for complex plan without organization',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Complex created successfully',
    schema: {
      example: {
        success: true,
        data: {
          _id: '507f1f77bcf86cd799439011',
          name: 'Central Medical Complex',
          status: 'active',
          email: 'info@centralmedical.com',
          phoneNumbers: ['+966501234567'],
          address: {
            street: 'King Fahd Road',
            city: 'Riyadh',
            country: 'Saudi Arabia',
          },
          organizationId: '507f1f77bcf86cd799439011',
          subscriptionId: '507f1f77bcf86cd799439012',
          ownerId: '507f1f77bcf86cd799439013',
          personInChargeId: '507f1f77bcf86cd799439014',
          createdAt: '2024-01-15T10:00:00.000Z',
          updatedAt: '2024-01-15T10:00:00.000Z',
        },
        message: {
          ar: 'تم إنشاء المجمع بنجاح',
          en: 'Complex created successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation error or business rule violation',
    schema: {
      examples: {
        'Plan Limit Exceeded': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_001',
              message: {
                ar: 'تم تجاوز حد الخطة. الخطة المعقدة تسمح بمجمع واحد كحد أقصى',
                en: 'Plan limit exceeded. Complex plan allows maximum 1 complex',
              },
            },
          },
        },
        'Invalid PIC': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_002',
              message: {
                ar: 'الشخص المسؤول غير صالح. يجب أن يكون موظفًا في المجمع',
                en: 'Invalid person-in-charge. Must be an employee of the complex',
              },
            },
          },
        },
        'Inactive Subscription': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_008',
              message: {
                ar: 'الاشتراك غير نشط',
                en: 'Subscription is not active',
              },
            },
          },
        },
        'Invalid Email': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_009',
              message: {
                ar: 'تنسيق البريد الإلكتروني غير صالح',
                en: 'Invalid email format',
              },
            },
          },
        },
      },
    },
  })
  async createComplex(@Body() createComplexDto: CreateComplexDto, @Request() req: any) {
    try {
      const complex = await this.complexService.createComplex(createComplexDto, req.user);
      return {
        success: true,
        data: complex,
        message: {
          ar: 'تم إنشاء المجمع بنجاح',
          en: 'Complex created successfully',
        },
      };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل إنشاء المجمع',
              en: 'Failed to create complex',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء إنشاء المجمع',
            en: 'An unexpected error occurred while creating complex',
          },
          details: error.message,
        },
      };
    }
  }

  @Get('dropdown')
  @ApiOperation({
    summary: 'Get complexes for dropdown',
    description: 'Returns lightweight complex list for dropdown selection',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complexes retrieved successfully',
    schema: {
      example: {
        success: true,
        data: [
          {
            _id: '507f1f77bcf86cd799439011',
            name: 'Central Medical Complex',
          },
        ],
        message: {
          ar: 'تم استرجاع قائمة المجمعات بنجاح',
          en: 'Complexes retrieved successfully',
        },
      },
    },
  })
  async getComplexesForDropdown(@Request() req: any) {
    try {
      return await this.complexService.getComplexesForDropdown(req.user);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل استرجاع قائمة المجمعات',
              en: 'Failed to retrieve complexes list',
            },
            details: errorResponse.details,
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء استرجاع قائمة المجمعات',
            en: 'An unexpected error occurred while retrieving complexes list',
          },
          details: error.message,
        },
      };
    }
  }

  @Get('subscription/:subscriptionId')
  async getComplexBySubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Request() req: any,
  ) {
    try {
      const complex =
        await this.complexService.getComplexBySubscription(subscriptionId, req.user);
      return {
        success: true,
        message: complex
          ? {
            ar: 'تم العثور على المجمع',
            en: 'Complex found',
          }
          : {
            ar: 'لم يتم العثور على مجمع لهذا الاشتراك',
            en: 'No complex found for this subscription',
          },
        data: complex,
      };
    } catch (error) {
      // Re-throw ForbiddenException so NestJS returns HTTP 403
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Handle specific error types
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل استرجاع المجمع حسب الاشتراك',
              en: 'Failed to retrieve complex by subscription',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle unexpected errors
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء استرجاع المجمع حسب الاشتراك',
            en: 'An unexpected error occurred while retrieving complex by subscription',
          },
          details: error.message,
        },
      };
    }
  }

  @Get('organization/:organizationId')
  async getComplexesByOrganization(
    @Param('organizationId') organizationId: string,
    @Request() req: any,
  ) {
    try {
      const complexes =
        await this.complexService.getComplexesByOrganization(organizationId, req.user);
      return {
        success: true,
        message: {
          ar: 'تم استرجاع المجمعات بنجاح',
          en: 'Complexes retrieved successfully',
        },
        data: complexes,
      };
    } catch (error) {
      // Re-throw ForbiddenException so NestJS returns HTTP 403
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Handle specific error types
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل استرجاع المجمعات حسب المنظمة',
              en: 'Failed to retrieve complexes by organization',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle unexpected errors
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء استرجاع المجمعات حسب المنظمة',
            en: 'An unexpected error occurred while retrieving complexes by organization',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Validate complex status change before updating
   * GET /complexes/:id/validate-status-change
   */
  @Get(':id/validate-status-change')
  @ApiOperation({
    summary: 'Validate complex status change',
    description:
      'Returns the warnings and transfer requirements needed before changing a complex status.',
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiQuery({
    name: 'status',
    required: true,
    enum: ['active', 'inactive', 'suspended'],
    description: 'Requested target status',
    example: 'inactive',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Status change validation completed successfully',
  })
  async validateComplexStatusChange(
    @Param('id') id: string,
    @Query('status') status: string,
    @Request() req: any,
  ) {
    const normalizedStatus = String(status || '').toLowerCase();

    if (!['active', 'inactive', 'suspended'].includes(normalizedStatus)) {
      throw new BadRequestException({
        code: 'COMPLEX_999',
        message: {
          ar: 'قيمة الحالة المطلوبة غير صالحة',
          en: 'Invalid requested status value',
        },
      });
    }

    return await this.complexService.validateStatusChange(
      id,
      normalizedStatus as 'active' | 'inactive' | 'suspended',
      req.user,
    );
  }

  /**
   * Get complex details with all relationships and calculated metrics
   * GET /complexes/:id
   *
   * Requirements: 2.1, 2.9
   */
  @Get(':id')
  @SkipAdminGuard()
  @ApiOperation({
    summary: 'Get detailed complex information',
    description: `
      Retrieves complete complex details including all relationships and calculated metrics.
      
      **Includes:**
      - All complex fields and relationships
      - Populated organization, subscription, owner, personInCharge
      - Scheduled appointments count
      - Active clinics count
      - Assigned clinic list (PIC, scheduled appointments, doctors, status)
      - Doctor and staff list for this complex
      - Departments count
      - Capacity calculations with utilization percentages
      - Per-clinic capacity breakdown
      
      **Use Cases:**
      - Display complex details page
      - Monitor complex capacity and utilization
      - View complex organizational structure
      
      **Requirements:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complex details retrieved successfully',
    schema: {
      example: {
        success: true,
        data: {
          _id: '507f1f77bcf86cd799439011',
          name: 'Central Medical Complex',
          status: 'active',
          email: 'info@centralmedical.com',
          phoneNumbers: ['+966501234567'],
          address: {
            street: 'King Fahd Road',
            city: 'Riyadh',
            country: 'Saudi Arabia',
          },
          organization: {
            _id: '507f1f77bcf86cd799439010',
            name: 'Healthcare Group',
          },
          subscription: {
            _id: '507f1f77bcf86cd799439012',
            planType: 'company',
            status: 'active',
          },
          owner: {
            _id: '507f1f77bcf86cd799439013',
            firstName: 'Mohammed',
            lastName: 'Al-Rashid',
            email: 'owner@centralmedical.com',
          },
          personInCharge: {
            _id: '507f1f77bcf86cd799439014',
            firstName: 'Ahmed',
            lastName: 'Al-Saud',
            email: 'ahmed@centralmedical.com',
          },
          scheduledAppointmentsCount: 45,
          clinicsAssignedCount: 8,
          assignedClinics: [
            {
              no: 1,
              clinicId: '507f1f77bcf86cd799439020',
              name: 'Cardiology Clinic',
              pic: 'Ahmed Al-Saud',
              scheduledAppointmentsCount: 12,
              doctors: 8,
              status: 'active',
            },
          ],
          doctorStaffList: [
            {
              no: 1,
              clinicId: '507f1f77bcf86cd799439020',
              name: 'Dr. Ahmed Al-Saud',
              clinic: 'Cardiology Clinic',
              userType: 'doctor',
              status: 'active',
            },
            {
              no: 2,
              clinicId: '507f1f77bcf86cd799439020',
              name: 'Mona Al-Harbi',
              clinic: 'Cardiology Clinic',
              userType: 'staff',
              status: 'active',
            },
          ],
          departmentsCount: 5,
          capacity: {
            total: {
              maxDoctors: 50,
              maxStaff: 100,
              maxPatients: 500,
            },
            current: {
              doctors: 35,
              staff: 75,
              patients: 320,
            },
            utilization: {
              doctors: 70,
              staff: 75,
              patients: 64,
            },
            byClinic: [
              {
                clinicId: '507f1f77bcf86cd799439020',
                clinicName: 'Cardiology Clinic',
                maxDoctors: 10,
                maxStaff: 20,
                maxPatients: 100,
                currentDoctors: 8,
                currentStaff: 15,
                currentPatients: 65,
              },
            ],
            recommendations: [],
          },
          createdAt: '2024-01-15T10:00:00.000Z',
          updatedAt: '2024-01-20T15:30:00.000Z',
        },
        message: {
          ar: 'تم استرجاع تفاصيل المجمع بنجاح',
          en: 'Complex details retrieved successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async getComplex(@Param('id') id: string, @Request() req: any) {
    try {
      return await this.complexService.getComplexDetails(id, req.user);
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل استرجاع تفاصيل المجمع',
              en: 'Failed to retrieve complex details',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء استرجاع تفاصيل المجمع',
            en: 'An unexpected error occurred while retrieving complex details',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Update complex with validation for department restrictions and PIC
   * PUT /complexes/:id
   *
   * Requirements: 4.9
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update complex information',
    description: `
      Updates complex information with validation for department restrictions and person-in-charge.
      
      **Validations:**
      - Complex must exist (COMPLEX_006)
      - Cannot remove departments linked to active clinics (COMPLEX_007)
      - Person-in-charge must be an employee (COMPLEX_002)
      - Email format validation (COMPLEX_009)
      - Phone format validation (COMPLEX_010)
      
      **Business Rules:**
      - BZR-36: Department restriction check
      - BZR-34: Person-in-charge validation
      
      **Special Behavior:**
      - Returns departmentRestrictions array if departments cannot be removed
      - Prevents update if restrictions exist
      
      **Requirements:** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({
    type: UpdateComplexDto,
    description: 'Complex update data',
    examples: {
      'Basic Update': {
        value: {
          name: 'Updated Medical Complex',
          email: 'updated@centralmedical.com',
          phoneNumbers: ['+966501234567'],
        },
        summary: 'Update basic complex information',
      },
      'Update with PIC': {
        value: {
          name: 'Central Medical Complex',
          personInChargeId: '507f1f77bcf86cd799439014',
        },
        summary: 'Update complex and assign person-in-charge',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complex updated successfully',
    schema: {
      example: {
        success: true,
        data: {
          _id: '507f1f77bcf86cd799439011',
          name: 'Updated Medical Complex',
          status: 'active',
          email: 'updated@centralmedical.com',
          updatedAt: '2024-01-20T15:30:00.000Z',
        },
        message: {
          ar: 'تم تحديث المجمع بنجاح',
          en: 'Complex updated successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation error or department restrictions',
    schema: {
      examples: {
        'Department Restrictions': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_007',
              message: {
                ar: 'القسم مرتبط بعيادات ولا يمكن إزالته',
                en: 'Department linked to clinics and cannot be removed',
              },
              departmentRestrictions: [
                {
                  departmentId: '507f1f77bcf86cd799439015',
                  departmentName: 'Cardiology',
                  linkedClinics: [
                    {
                      clinicId: '507f1f77bcf86cd799439020',
                      clinicName: 'Cardiology Clinic A',
                    },
                  ],
                },
              ],
            },
          },
        },
        'Invalid PIC': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_002',
              message: {
                ar: 'الشخص المسؤول غير صالح. يجب أن يكون موظفًا في المجمع',
                en: 'Invalid person-in-charge. Must be an employee of the complex',
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async updateComplex(
    @Param('id') id: string,
    @Body() updateComplexDto: UpdateComplexDto,
    @Request() req: any,
  ) {
    try {
      const result = await this.complexService.updateComplex(
        id,
        updateComplexDto,
        req.user,
      );

      // Return the result which includes departmentRestrictions if any
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل تحديث المجمع',
              en: 'Failed to update complex',
            },
            details: errorResponse.details,
            departmentRestrictions: errorResponse.departmentRestrictions,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء تحديث المجمع',
            en: 'An unexpected error occurred while updating complex',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Partially update complex with validation for department restrictions and PIC
   * PATCH /complexes/:id
   *
   * Requirements: 4.9
   */
  @Patch(':id')
  @ApiOperation({
    summary: 'Partially update complex information',
    description: `
      Partially updates complex information with validation for department restrictions and person-in-charge.
      
      **Validations:**
      - Complex must exist (COMPLEX_006)
      - Cannot remove departments linked to active clinics (COMPLEX_007)
      - Person-in-charge must be an employee (COMPLEX_002)
      - Email format validation (COMPLEX_009)
      - Phone format validation (COMPLEX_010)
      
      **Business Rules:**
      - BZR-36: Department restriction check
      - BZR-34: Person-in-charge validation
      
      **Special Behavior:**
      - Returns departmentRestrictions array if departments cannot be removed
      - Prevents update if restrictions exist
      
      **Requirements:** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({
    type: UpdateComplexDto,
    description: 'Complex update data',
    examples: {
      'Basic Update': {
        value: {
          name: 'Updated Medical Complex',
        },
        summary: 'Update basic complex information',
      },
      'Update Vision': {
        value: {
          vision: 'To be the world-class medical complex in the region',
        },
        summary: 'Update complex vision',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complex updated successfully',
    schema: {
      example: {
        success: true,
        data: {
          _id: '507f1f77bcf86cd799439011',
          name: 'Updated Medical Complex',
          status: 'active',
          updatedAt: '2024-01-20T15:30:00.000Z',
        },
        message: {
          ar: 'تم تحديث المجمع بنجاح',
          en: 'Complex updated successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation error or department restrictions',
    schema: {
      examples: {
        'Department Restrictions': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_007',
              message: {
                ar: 'القسم مرتبط بعيادات ولا يمكن إزالته',
                en: 'Department linked to clinics and cannot be removed',
              },
              departmentRestrictions: [
                {
                  departmentId: '507f1f77bcf86cd799439015',
                  departmentName: 'Cardiology',
                  linkedClinics: [
                    {
                      clinicId: '507f1f77bcf86cd799439020',
                      clinicName: 'Cardiology Clinic A',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async patchComplex(
    @Param('id') id: string,
    @Body() updateComplexDto: UpdateComplexDto,
    @Request() req: any,
  ) {
    try {
      const result = await this.complexService.updateComplex(
        id,
        updateComplexDto,
        req.user,
      );

      // Return the result which includes departmentRestrictions if any
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل تحديث المجمع',
              en: 'Failed to update complex',
            },
            details: errorResponse.details,
            departmentRestrictions: errorResponse.departmentRestrictions,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء تحديث المجمع',
            en: 'An unexpected error occurred while updating complex',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Soft delete a complex
   * DELETE /complexes/:id
   *
   * Requirements: 5.6
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Soft delete a complex',
    description: `
      Soft deletes a complex by setting the deletedAt timestamp.
      
      **Validations:**
      - Complex must exist (COMPLEX_006)
      - Complex must not have active clinics (COMPLEX_003)
      
      **Behavior:**
      - Sets deletedAt timestamp
      - Preserves all complex data for historical records
      - Does not physically delete the record
      
      **Requirements:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complex deleted successfully',
    schema: {
      example: {
        success: true,
        message: {
          ar: 'تم حذف المجمع بنجاح',
          en: 'Complex deleted successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Complex has active clinics',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_003',
          message: {
            ar: 'لا يمكن حذف المجمع مع وجود عيادات نشطة',
            en: 'Cannot delete complex with active clinics',
          },
          details: {
            activeClinicsCount: 5,
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async softDeleteComplex(@Param('id') id: string, @Request() req: any) {
    try {
      return await this.complexService.softDeleteComplex(id, req.user);
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error (e.g., COMPLEX_003)
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل حذف المجمع',
              en: 'Failed to delete complex',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء حذف المجمع',
            en: 'An unexpected error occurred while deleting complex',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Update complex status with cascading effects
   * PATCH /complexes/:id/status
   *
   * Requirements: 6.10
   */
  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update complex status with cascading effects',
    description: `
      Changes complex status with automatic cascading effects on dependent entities.
      
      **Cascading Effects:**
      - Deactivates all services linked to the complex (BZR-37)
      - Transfers clinics to target complex if specified (BZR-38)
      - Marks conflicting appointments for rescheduling
      - Records deactivation audit trail
      - Sends notifications to affected users
      
      **Validations:**
      - Complex must exist (COMPLEX_006)
      - Target complex required if deactivating with clinics (COMPLEX_004)
      - Target complex must exist and be active (COMPLEX_005)
      
      **Transaction Support:**
      - All operations are atomic (rollback on error)
      
      **Requirements:** 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({
    type: UpdateComplexStatusDto,
    description: 'Status update data',
    examples: {
      'Deactivate with Transfer': {
        value: {
          status: 'inactive',
          targetComplexId: '507f1f77bcf86cd799439012',
          transferClinics: true,
          deactivationReason: 'Temporary closure for renovation',
        },
        summary: 'Deactivate complex and transfer clinics to another complex',
      },
      'Suspend Complex': {
        value: {
          status: 'suspended',
          deactivationReason: 'License renewal pending',
        },
        summary: 'Suspend complex without transferring clinics',
      },
      'Reactivate Complex': {
        value: {
          status: 'active',
        },
        summary: 'Reactivate a previously deactivated complex',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Complex status updated successfully',
    schema: {
      example: {
        success: true,
        data: {
          complex: {
            _id: '507f1f77bcf86cd799439011',
            name: 'Central Medical Complex',
            status: 'inactive',
            deactivatedAt: '2024-01-20T15:30:00.000Z',
            deactivatedBy: '507f1f77bcf86cd799439013',
            deactivationReason: 'Temporary closure for renovation',
          },
          servicesDeactivated: 25,
          clinicsTransferred: 8,
          appointmentsMarkedForRescheduling: 15,
        },
        message: {
          ar: 'تم تحديث حالة المجمع بنجاح',
          en: 'Complex status updated successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation error or business rule violation',
    schema: {
      examples: {
        'Target Complex Required': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_004',
              message: {
                ar: 'يجب نقل العيادات قبل إلغاء التنشيط',
                en: 'Must transfer clinics before deactivation',
              },
            },
          },
        },
        'Invalid Target Complex': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_005',
              message: {
                ar: 'المجمع المستهدف غير صالح للنقل',
                en: 'Invalid target complex for transfer',
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async updateComplexStatus(
    @Param('id') id: string,
    @Body() updateComplexStatusDto: UpdateComplexStatusDto,
    @Request() req: any,
  ) {
    try {
      return await this.complexService.updateComplexStatus(
        id,
        updateComplexStatusDto,
        req.user.id,
        req.user,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        throw new NotFoundException({
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: '?????? ??? ?????',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        });
      }

      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        throw new BadRequestException({
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: '??? ????? ???? ??????',
              en: 'Failed to update complex status',
            },
            details: errorResponse.details,
          },
        });
      }

      throw new BadRequestException({
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: '??? ??? ??? ????? ????? ????? ???? ??????',
            en: 'An unexpected error occurred while updating complex status',
          },
          details: (error as any)?.message,
        },
      });
    }
  }

  /**
   * Get complex capacity with breakdown and utilization
   * GET /complexes/:id/capacity
   *
   * Requirements: 7.6
   */
  @Get(':id/capacity')
  @ApiOperation({
    summary: 'Calculate complex capacity and utilization',
    description: `
      Calculates total capacity from all active clinics with current utilization.
      
      **Calculations:**
      - Total capacity: Sum of all active clinic capacities (BZR-33)
      - Current counts: Actual doctors, staff, patients
      - Utilization: (current/total) * 100 (BZR-35)
      - Per-clinic breakdown
      - Recommendations when capacity exceeded
      
      **Use Cases:**
      - Monitor resource allocation
      - Identify capacity issues
      - Plan resource expansion
      - Track utilization trends
      
      **Requirements:** 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Capacity calculated successfully',
    schema: {
      example: {
        success: true,
        data: {
          total: {
            maxDoctors: 50,
            maxStaff: 100,
            maxPatients: 500,
          },
          current: {
            doctors: 35,
            staff: 75,
            patients: 320,
          },
          utilization: {
            doctors: 70,
            staff: 75,
            patients: 64,
          },
          byClinic: [
            {
              clinicId: '507f1f77bcf86cd799439020',
              clinicName: 'Cardiology Clinic',
              maxDoctors: 10,
              maxStaff: 20,
              maxPatients: 100,
              currentDoctors: 8,
              currentStaff: 15,
              currentPatients: 65,
            },
            {
              clinicId: '507f1f77bcf86cd799439021',
              clinicName: 'Pediatrics Clinic',
              maxDoctors: 15,
              maxStaff: 25,
              maxPatients: 150,
              currentDoctors: 12,
              currentStaff: 20,
              currentPatients: 95,
            },
          ],
          recommendations: [],
        },
        message: {
          ar: 'تم حساب سعة المجمع بنجاح',
          en: 'Complex capacity calculated successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async getComplexCapacity(@Param('id') id: string, @Request() req: any) {
    try {
      return await this.complexService.getComplexCapacity(id, req.user);
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل حساب سعة المجمع',
              en: 'Failed to calculate complex capacity',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء حساب سعة المجمع',
            en: 'An unexpected error occurred while calculating complex capacity',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Assign person-in-charge to a complex
   * PATCH /complexes/:id/pic
   *
   * Requirements: 8.6
   */
  @Patch(':id/pic')
  @ApiOperation({
    summary: 'Assign person-in-charge to complex',
    description: `
      Assigns a user as the person-in-charge (PIC) for a complex.
      
      **Validations:**
      - Complex must exist (COMPLEX_006)
      - User must exist (COMPLEX_002)
      - User must be an employee of the complex (BZR-34)
      - User role must not be 'patient'
      
      **Use Cases:**
      - Assign complex manager
      - Update responsible person
      - Establish accountability
      
      **Requirements:** 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({
    type: AssignComplexPICDto,
    description: 'Person-in-charge assignment data',
    examples: {
      'Assign PIC': {
        value: {
          userId: '507f1f77bcf86cd799439014',
        },
        summary: 'Assign a user as person-in-charge',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Person-in-charge assigned successfully',
    schema: {
      example: {
        success: true,
        data: {
          _id: '507f1f77bcf86cd799439011',
          name: 'Central Medical Complex',
          personInChargeId: '507f1f77bcf86cd799439014',
          personInCharge: {
            _id: '507f1f77bcf86cd799439014',
            firstName: 'Ahmed',
            lastName: 'Al-Saud',
            email: 'ahmed@centralmedical.com',
            role: 'admin',
          },
        },
        message: {
          ar: 'تم تعيين الشخص المسؤول بنجاح',
          en: 'Person-in-charge assigned successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid person-in-charge',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_002',
          message: {
            ar: 'الشخص المسؤول غير صالح. يجب أن يكون موظفًا في المجمع',
            en: 'Invalid person-in-charge. Must be an employee of the complex',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async assignPersonInCharge(
    @Param('id') id: string,
    @Body() assignPICDto: AssignComplexPICDto,
    @Request() req: any,
  ) {
    try {
      return await this.complexService.assignPersonInCharge(
        id,
        assignPICDto.userId,
        req.user,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error (e.g., COMPLEX_002)
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل تعيين الشخص المسؤول',
              en: 'Failed to assign person-in-charge',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء تعيين الشخص المسؤول',
            en: 'An unexpected error occurred while assigning person-in-charge',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Remove person-in-charge from a complex
   * DELETE /complexes/:id/pic
   *
   * Requirements: 9.4
   */
  @Delete(':id/pic')
  @ApiOperation({
    summary: 'Remove person-in-charge from complex',
    description: `
      Removes the person-in-charge assignment from a complex.
      
      **Behavior:**
      - Sets personInChargeId to null
      - Does not delete the user
      - Complex remains operational
      
      **Use Cases:**
      - Remove manager assignment
      - Clear responsibility before reassignment
      - Temporary management changes
      
      **Requirements:** 9.1, 9.2, 9.3, 9.4
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Person-in-charge removed successfully',
    schema: {
      example: {
        success: true,
        message: {
          ar: 'تم إزالة الشخص المسؤول بنجاح',
          en: 'Person-in-charge removed successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async removePersonInCharge(@Param('id') id: string, @Request() req: any) {
    try {
      return await this.complexService.removePersonInCharge(id, req.user);
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل إزالة الشخص المسؤول',
              en: 'Failed to remove person-in-charge',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء إزالة الشخص المسؤول',
            en: 'An unexpected error occurred while removing person-in-charge',
          },
          details: error.message,
        },
      };
    }
  }

  /**
   * Transfer clinics from source complex to target complex
   * POST /complexes/:id/transfer-clinics
   *
   * Requirements: 10.10
   */
  @Post(':id/transfer-clinics')
  @ApiOperation({
    summary: 'Transfer clinics between complexes',
    description: `
      Transfers specified clinics from source complex to target complex with conflict resolution.
      
      **Operations:**
      - Validates source and target complexes
      - Validates clinic ownership
      - Transfers clinic records atomically
      - Updates staff assignments (users with clinicId)
      - Checks for working hours conflicts
      - Marks conflicting appointments for rescheduling
      
      **Validations:**
      - Source complex must exist (COMPLEX_006)
      - Target complex must exist and be active (COMPLEX_005)
      - All clinics must belong to source complex
      
      **Transaction Support:**
      - All operations are atomic (rollback on error)
      
      **Requirements:** 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10
    `,
  })
  @ApiParam({
    name: 'id',
    type: String,
    description: 'Source Complex ID (MongoDB ObjectId)',
    example: '507f1f77bcf86cd799439011',
  })
  @ApiBody({
    type: TransferClinicsDto,
    description: 'Clinic transfer data',
    examples: {
      'Transfer Multiple Clinics': {
        value: {
          targetComplexId: '507f1f77bcf86cd799439012',
          clinicIds: [
            '507f1f77bcf86cd799439020',
            '507f1f77bcf86cd799439021',
            '507f1f77bcf86cd799439022',
          ],
        },
        summary: 'Transfer multiple clinics to another complex',
      },
      'Transfer Single Clinic': {
        value: {
          targetComplexId: '507f1f77bcf86cd799439012',
          clinicIds: ['507f1f77bcf86cd799439020'],
        },
        summary: 'Transfer a single clinic',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Clinics transferred successfully',
    schema: {
      example: {
        success: true,
        data: {
          clinicsTransferred: 5,
          staffUpdated: 25,
          appointmentsMarkedForRescheduling: 12,
          conflicts: [
            {
              clinicId: '507f1f77bcf86cd799439020',
              clinicName: 'Cardiology Clinic',
              conflictType: 'working_hours_mismatch',
              details:
                'Source complex operates 8AM-8PM, target complex operates 9AM-5PM',
            },
          ],
        },
        message: {
          ar: 'تم نقل العيادات بنجاح',
          en: 'Clinics transferred successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation error or invalid target complex',
    schema: {
      examples: {
        'Invalid Target Complex': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_005',
              message: {
                ar: 'المجمع المستهدف غير صالح للنقل',
                en: 'Invalid target complex for transfer',
              },
            },
          },
        },
        'Invalid Clinic Ownership': {
          value: {
            success: false,
            error: {
              code: 'COMPLEX_999',
              message: {
                ar: 'بعض العيادات لا تنتمي إلى المجمع المصدر',
                en: 'Some clinics do not belong to the source complex',
              },
              details: {
                invalidClinicIds: ['507f1f77bcf86cd799439020'],
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Source or target complex not found',
    schema: {
      example: {
        success: false,
        error: {
          code: 'COMPLEX_006',
          message: {
            ar: 'المجمع غير موجود',
            en: 'Complex not found',
          },
        },
      },
    },
  })
  async transferClinics(
    @Param('id') sourceComplexId: string,
    @Body() transferClinicsDto: TransferClinicsDto,
    @Request() req: any,
  ) {
    try {
      return await this.complexService.transferClinics(
        sourceComplexId,
        transferClinicsDto.targetComplexId,
        transferClinicsDto.clinicIds,
        req.user,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;

      // Handle NotFoundException with bilingual error
      if (error instanceof NotFoundException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_006',
            message: errorResponse.message || {
              ar: 'المجمع غير موجود',
              en: 'Complex not found',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle BadRequestException with bilingual error (e.g., COMPLEX_005, validation errors)
      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as any;
        return {
          success: false,
          error: {
            code: errorResponse.code || 'COMPLEX_999',
            message: errorResponse.message || {
              ar: 'فشل نقل العيادات',
              en: 'Failed to transfer clinics',
            },
            details: errorResponse.details,
          },
        };
      }

      // Handle other errors with generic bilingual message
      return {
        success: false,
        error: {
          code: 'COMPLEX_999',
          message: {
            ar: 'حدث خطأ غير متوقع أثناء نقل العيادات',
            en: 'An unexpected error occurred while transferring clinics',
          },
          details: error.message,
        },
      };
    }
  }
}
