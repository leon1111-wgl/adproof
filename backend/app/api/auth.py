from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User
from ..security import create_token, get_current_user, verify_password
from ..seed import DEMO_PASSWORD, DEMO_USERS

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


def user_out(user: User) -> dict:
    return {"id": user.id, "email": user.email, "name": user.name, "title": user.title, "role": user.role}


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)) -> dict:
    user = db.execute(select(User).where(User.email == body.email.strip().lower())).scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "邮箱或密码错误")
    return {"token": create_token(user), "user": user_out(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)) -> dict:
    return user_out(user)


@router.get("/demo-accounts")
def demo_accounts() -> dict:
    if not get_settings().seed_demo:
        return {"password": None, "accounts": []}
    return {"password": DEMO_PASSWORD, "accounts": DEMO_USERS}
