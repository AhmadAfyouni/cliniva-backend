import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { DepartmentService } from './department.service';

describe('DepartmentService', () => {
  let service: DepartmentService;
  let departmentModel: any;
  let complexDepartmentModel: any;
  let clinicModel: any;
  let serviceModel: any;

  const createMockModel = () => ({
    find: jest.fn().mockReturnThis(),
    findById: jest.fn(),
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  });

  beforeEach(async () => {
    departmentModel = createMockModel();
    complexDepartmentModel = createMockModel();
    clinicModel = createMockModel();
    serviceModel = createMockModel();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        {
          provide: getModelToken('Department'),
          useValue: departmentModel,
        },
        {
          provide: getModelToken('ComplexDepartment'),
          useValue: complexDepartmentModel,
        },
        {
          provide: getModelToken('Clinic'),
          useValue: clinicModel,
        },
        {
          provide: getModelToken('Service'),
          useValue: serviceModel,
        },
      ],
    }).compile();

    service = module.get<DepartmentService>(DepartmentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should block deletion when a clinic still references the raw department id', async () => {
    const departmentId = new Types.ObjectId().toString();
    const complexDepartmentId = new Types.ObjectId();

    departmentModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: departmentId, name: 'Dept A' }),
    });
    complexDepartmentModel.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: complexDepartmentId }]),
    });
    clinicModel.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          name: 'Clinic A',
          complexId: {
            _id: new Types.ObjectId(),
            name: 'Complex A',
          },
        },
      ]),
    });

    const result = await service.canDeleteDepartment(departmentId);

    expect(clinicModel.find).toHaveBeenCalledWith({
      complexDepartmentId: {
        $in: [new Types.ObjectId(departmentId), complexDepartmentId],
      },
      deletedAt: null,
    });
    expect(result.data.canDelete).toBe(false);
    expect(result.data.linkedClinics).toHaveLength(1);
  });
});
