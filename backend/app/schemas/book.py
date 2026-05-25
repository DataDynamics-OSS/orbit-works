"""Book — Pydantic schemas."""

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, Field


class BookBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    location: str | None = Field(default=None, max_length=200)
    publisher: str | None = Field(default=None, max_length=150)
    category: str | None = Field(default=None, max_length=100)
    price: int | None = Field(default=None, ge=0)
    borrower_id: UUID | None = None
    borrowed_at: datetime | None = None
    due_date: date | None = None
    registered_at: date | None = None
    note: str | None = None


class BookCreate(BookBase):
    pass


class BookUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    location: str | None = Field(default=None, max_length=200)
    publisher: str | None = Field(default=None, max_length=150)
    category: str | None = Field(default=None, max_length=100)
    price: int | None = Field(default=None, ge=0)
    borrower_id: UUID | None = None
    borrowed_at: datetime | None = None
    due_date: date | None = None
    registered_at: date | None = None
    note: str | None = None


class BookOut(BookBase):
    id: UUID
    borrower_name: str | None = None  # derived (developer.name)
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
